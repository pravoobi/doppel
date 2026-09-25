import { PNG } from "pngjs"
import { describe, expect, it } from "vitest"
import { diffPngBuffers, ImageDimensionMismatchError } from "../src/diff.js"

function solidPng(width: number, height: number, [r, g, b, a]: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2
      png.data[idx] = r
      png.data[idx + 1] = g
      png.data[idx + 2] = b
      png.data[idx + 3] = a
    }
  }
  return PNG.sync.write(png)
}

/** Same as solidPng but with a block of `count` pixels in the top-left corner recolored. */
function solidPngWithSpots(
  width: number,
  height: number,
  base: [number, number, number, number],
  spot: [number, number, number, number],
  count: number
): Buffer {
  const png = PNG.sync.read(solidPng(width, height, base))
  for (let i = 0; i < count && i < width * height; i++) {
    const idx = i << 2
    png.data[idx] = spot[0]
    png.data[idx + 1] = spot[1]
    png.data[idx + 2] = spot[2]
    png.data[idx + 3] = spot[3]
  }
  return PNG.sync.write(png)
}

describe("diffPngBuffers", () => {
  const WHITE: [number, number, number, number] = [255, 255, 255, 255]
  const BLACK: [number, number, number, number] = [0, 0, 0, 255]

  it("returns ~0 deltaRatio for identical images", () => {
    const a = solidPng(100, 100, WHITE)
    const b = solidPng(100, 100, WHITE)
    const result = diffPngBuffers(a, b)
    expect(result.deltaRatio).toBe(0)
    expect(result.width).toBe(100)
    expect(result.height).toBe(100)
  })

  it("returns a small deltaRatio proportional to the number of changed pixels", () => {
    const a = solidPng(100, 100, WHITE)
    // 100 of 10,000 pixels changed = exactly 1%.
    const b = solidPngWithSpots(100, 100, WHITE, BLACK, 100)
    const result = diffPngBuffers(a, b)
    expect(result.deltaRatio).toBeCloseTo(0.01, 2)
  })

  it("returns a large deltaRatio when the whole image differs", () => {
    const a = solidPng(50, 50, WHITE)
    const b = solidPng(50, 50, BLACK)
    const result = diffPngBuffers(a, b)
    expect(result.deltaRatio).toBeGreaterThan(0.9)
  })

  it("produces a diff PNG the same dimensions as the inputs", () => {
    const a = solidPng(64, 32, WHITE)
    const b = solidPngWithSpots(64, 32, WHITE, BLACK, 10)
    const result = diffPngBuffers(a, b)
    const decoded = PNG.sync.read(result.diffPng)
    expect(decoded.width).toBe(64)
    expect(decoded.height).toBe(32)
  })

  it("throws ImageDimensionMismatchError when dimensions differ, not a generic error", () => {
    const a = solidPng(100, 100, WHITE)
    const b = solidPng(50, 50, WHITE)
    expect(() => diffPngBuffers(a, b)).toThrow(ImageDimensionMismatchError)
  })
})
