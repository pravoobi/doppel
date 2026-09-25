/**
 * Playwright screenshot capture (CLAUDE.md §5.7 step 2): 3 viewports (375/768/
 * 1440), plus dark mode if the repo sets a `dark` class. This module only
 * GENERATES the driver script and PARSES its output — it never runs Playwright
 * itself (this package has no Playwright dependency; the sandbox image does).
 * Symmetric with harness.ts: pure string generation, sandbox-independent,
 * testable without a browser.
 *
 * Retrieval mechanism: the generated script prints each screenshot as base64
 * PNG to stdout with a line-based marker protocol, since file extraction from a
 * sandbox after a command completes is not a verified capability (only stdout/
 * stderr capture is — confirmed live, see docs/DECISIONS.md). This does mean
 * screenshot size is bounded by the sandbox's `truncate_output_at` setting;
 * `packages/verifier` callers should raise it well above the ~1MB default when
 * spawning (see SandboxClient — `truncate_output_at` isn't yet a first-class
 * field there; pass it through `env`/raw request until it is).
 */

import type { HARNESS_ERROR_ATTR, HARNESS_READY_ATTR } from "./harness"

/** §5.7 step 2's exact viewport widths. */
export const VIEWPORTS = [375, 768, 1440] as const

const READY_ATTR_NAME = "doppelReady" satisfies typeof HARNESS_READY_ATTR
const ERROR_ATTR_NAME = "doppelError" satisfies typeof HARNESS_ERROR_ATTR

const SCREENSHOT_MARKER = "DOPPEL_SCREENSHOT"
const ERROR_MARKER = "DOPPEL_RENDER_ERROR"
const DONE_MARKER = "DOPPEL_SHOOT_DONE"

export type ShootInput = {
  /**
   * Path to the built harness's index.html, relative to wherever this script
   * runs. Resolved to a file:// URL at RUNTIME via `process.cwd()`, not baked
   * in at generation time — the script is written once and executed as part of
   * a chained sandbox command whose absolute working directory isn't known
   * until the sandbox actually runs it.
   */
  htmlPath: string
  viewports?: readonly number[]
  /** Fixed viewport height before the full-page screenshot extends past it. */
  viewportHeight?: number
  darkMode?: boolean
  /** ms to wait for the harness's ready/error dataset attribute per viewport. */
  readyTimeoutMs?: number
}

export function generateShootScript(input: ShootInput): string {
  const viewports = input.viewports ?? VIEWPORTS
  const viewportHeight = input.viewportHeight ?? 800
  const readyTimeoutMs = input.readyTimeoutMs ?? 10_000

  return `import { chromium } from "playwright"
import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const VIEWPORTS = ${JSON.stringify(viewports)}
const HTML_PATH = path.resolve(process.cwd(), ${JSON.stringify(input.htmlPath)})
const SERVE_DIR = path.dirname(HTML_PATH)
const READY_TIMEOUT_MS = ${readyTimeoutMs}

const CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
}

// A built file with <script type="module"> won't execute at all when loaded
// via a bare file:// URL — Chromium blocks ES module script loading over
// file:// origins. Serving over a real (if local, ephemeral-port) HTTP origin
// avoids that entirely; it's why this uses Node's built-in http/fs instead of
// page.goto("file://...") for what would otherwise be a simpler script.
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqPath = (req.url ?? "/").split("?")[0]
      const filePath = path.join(SERVE_DIR, reqPath === "/" ? "index.html" : reqPath)
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404)
          res.end()
          return
        }
        const ext = path.extname(filePath)
        res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" })
        res.end(data)
      })
    })
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

async function main() {
  const server = await startServer()
  const port = server.address().port
  const url = \`http://127.0.0.1:\${port}/\${path.basename(HTML_PATH)}\`

  const browser = await chromium.launch()
  let renderErrored = false

  for (const width of VIEWPORTS) {
    const page = await browser.newPage({
      viewport: { width, height: ${viewportHeight} },
      colorScheme: ${input.darkMode ? '"dark"' : '"light"'},
    })

    try {
      await page.goto(url)
      // waitForFunction's signature is (pageFunction, arg, options) — the
      // options object goes THIRD, not second, or it silently gets treated as
      // "arg" and the call falls back to Playwright's own default timeout.
      await page.waitForFunction(
        () => document.body.dataset.${READY_ATTR_NAME} || document.body.dataset.${ERROR_ATTR_NAME},
        undefined,
        { timeout: READY_TIMEOUT_MS }
      )

      const errorMessage = await page.evaluate(() => document.body.dataset.${ERROR_ATTR_NAME} ?? null)
      if (errorMessage) {
        console.log(\`${ERROR_MARKER}:\${JSON.stringify(errorMessage)}\`)
        renderErrored = true
        await page.close()
        break
      }

      const buffer = await page.screenshot({ fullPage: true })
      console.log(\`${SCREENSHOT_MARKER}:\${width}:\${buffer.toString("base64")}\`)
    } catch (err) {
      console.log(\`${ERROR_MARKER}:\${JSON.stringify("timed out waiting to mount: " + (err instanceof Error ? err.message : String(err)))}\`)
      renderErrored = true
      await page.close()
      break
    }

    await page.close()
  }

  await browser.close()
  server.close()
  console.log("${DONE_MARKER}")
  process.exit(renderErrored ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
`
}

export type ShootResult = {
  renderable: boolean
  errorMessage?: string
  /** Keyed by viewport width. */
  screenshots: Map<number, Buffer>
}

/** Parses the line-based stdout protocol `generateShootScript`'s output follows. */
export function parseShootOutput(stdout: string): ShootResult {
  const screenshots = new Map<number, Buffer>()
  let errorMessage: string | undefined

  for (const line of stdout.split("\n")) {
    if (line.startsWith(`${SCREENSHOT_MARKER}:`)) {
      const rest = line.slice(SCREENSHOT_MARKER.length + 1)
      const separatorIdx = rest.indexOf(":")
      if (separatorIdx === -1) continue
      const width = Number(rest.slice(0, separatorIdx))
      const base64 = rest.slice(separatorIdx + 1)
      if (!Number.isNaN(width) && base64.length > 0) {
        screenshots.set(width, Buffer.from(base64, "base64"))
      }
    } else if (line.startsWith(`${ERROR_MARKER}:`)) {
      try {
        errorMessage = JSON.parse(line.slice(ERROR_MARKER.length + 1)) as string
      } catch {
        errorMessage = line.slice(ERROR_MARKER.length + 1)
      }
    }
  }

  if (errorMessage) {
    return { renderable: false, errorMessage, screenshots }
  }
  return { renderable: screenshots.size > 0, screenshots }
}
