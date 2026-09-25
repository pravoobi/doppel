/**
 * Pixel diffing (CLAUDE.md §5.7 step 3): pixelmatch with anti-aliasing tolerance
 * on, producing a deltaRatio. Pure image processing — no sandbox, no network.
 */

import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"

export type DiffResult = {
  /** Fraction of pixels that differ, 0-1. This is what verdict.ts's thresholds compare against. */
  deltaRatio: number
  diffPng: Buffer
  width: number
  height: number
}

export type DiffOptions = {
  /** Per-pixel color-difference sensitivity (pixelmatch's own `threshold`, 0-1). Not the same as deltaRatio. */
  pixelThreshold?: number
}

export class ImageDimensionMismatchError extends Error {
  constructor(
    public readonly before: { width: number; height: number },
    public readonly after: { width: number; height: number }
  ) {
    super(
      `Image dimensions differ: before ${before.width}x${before.height}, after ${after.width}x${after.height} — ` +
        `cannot diff. This usually means the harness itself broke, not that the migration is wrong.`
    )
    this.name = "ImageDimensionMismatchError"
  }
}

export function diffPngBuffers(beforePng: Buffer, afterPng: Buffer, opts: DiffOptions = {}): DiffResult {
  const before = PNG.sync.read(beforePng)
  const after = PNG.sync.read(afterPng)

  if (before.width !== after.width || before.height !== after.height) {
    throw new ImageDimensionMismatchError(
      { width: before.width, height: before.height },
      { width: after.width, height: after.height }
    )
  }

  const { width, height } = before
  const diff = new PNG({ width, height })

  const mismatchedPixels = pixelmatch(before.data, after.data, diff.data, width, height, {
    threshold: opts.pixelThreshold ?? 0.1,
    // includeAA: false is pixelmatch's default and IS the "anti-aliasing tolerance
    // on" behavior §5.7 asks for — anti-aliased edge pixels are ignored rather
    // than counted as diffs. Set explicitly so the intent isn't just "whatever
    // the default happens to be."
    includeAA: false,
  })

  return {
    deltaRatio: mismatchedPixels / (width * height),
    diffPng: PNG.sync.write(diff),
    width,
    height,
  }
}
