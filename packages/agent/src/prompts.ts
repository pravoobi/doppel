/**
 * Loads prompt templates from packages/agent/prompts/*.md at runtime (CLAUDE.md
 * §15: "Prompts live in packages/agent/prompts/*.md and are loaded at runtime,
 * never inlined in code."). Minimal `{{var}}` substitution — no templating engine.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIR = path.resolve(__dirname, "../prompts")

const cache = new Map<string, string>()

export function loadPrompt(name: string, vars: Record<string, string> = {}): string {
  let template = cache.get(name)
  if (template === undefined) {
    template = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), "utf8")
    cache.set(name, template)
  }

  let out = template
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value)
  }

  const unresolved = out.match(/\{\{\w+\}\}/g)
  if (unresolved) {
    throw new Error(`Prompt "${name}" has unresolved placeholders: ${unresolved.join(", ")}`)
  }

  return out
}
