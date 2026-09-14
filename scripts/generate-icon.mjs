// Build-machine helper: generate build/icon.png with no image libraries.
//
// 尺寸是有硬性下限的，不是随便选的：
//   * macOS 打包拒绝小于 512x512 的源图
//     （electron-builder: "cannot convert icon … must be at least 512x512"）
//   * Windows 的 .ico 需要多个尺寸，源图太小时会被放大而模糊
// 因此默认输出 1024x1024。
//
// 用法：
//   node scripts/generate-icon.mjs           1024x1024
//   node scripts/generate-icon.mjs 512       指定边长
//
// The mark echoes the harness idea: a bracket frame around a node graph.
// Replace build/icon.png with real branding before shipping a release.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 设计基准尺寸：所有坐标都按这个尺寸书写，再按比例缩放到 SIZE。 */
const DESIGN = 256
const SIZE = Number(process.argv[2] ?? 1024)
if (!Number.isFinite(SIZE) || SIZE < 256) {
  console.error('边长至少 256；macOS 打包要求源图不小于 512')
  process.exit(1)
}
/** 设计坐标 -> 实际像素的比例。 */
const S = SIZE / DESIGN
const ROOT = resolve(import.meta.dirname, '..')
const OUT_DIR = join(ROOT, 'build')

/** Minimal RGBA canvas. */
const pixels = new Uint8Array(SIZE * SIZE * 4)

/** Blend one pixel, source-over, coordinates outside the canvas are ignored. */
function blend(x, y, [r, g, b], alpha) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || alpha <= 0) return
  const index = (y * SIZE + x) * 4
  const a = Math.min(1, alpha)
  const dstA = pixels[index + 3] / 255
  const outA = a + dstA * (1 - a)
  if (outA === 0) return
  pixels[index] = Math.round((r * a + pixels[index] * dstA * (1 - a)) / outA)
  pixels[index + 1] = Math.round((g * a + pixels[index + 1] * dstA * (1 - a)) / outA)
  pixels[index + 2] = Math.round((b * a + pixels[index + 2] * dstA * (1 - a)) / outA)
  pixels[index + 3] = Math.round(outA * 255)
}

/** Anti-aliased filled disc. */
function disc(cx, cy, radius, color, alpha = 1) {
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y += 1) {
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      blend(x, y, color, Math.max(0, Math.min(1, radius + 0.5 - distance)) * alpha)
    }
  }
}

/** Anti-aliased line segment of a given width. */
function line(x1, y1, x2, y2, width, color, alpha = 1) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2)
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    disc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, color, alpha)
  }
}

/** Rounded-rect outline: four lines plus arcs approximated by dense line joins. */
function roundedFrame(left, top, right, bottom, radius, width, color, alpha = 1) {
  line(left + radius, top, right - radius, top, width, color, alpha)
  line(left + radius, bottom, right - radius, bottom, width, color, alpha)
  line(left, top + radius, left, bottom - radius, width, color, alpha)
  line(right, top + radius, right, bottom - radius, width, color, alpha)
  for (const [cx, cy, start] of [
    [left + radius, top + radius, Math.PI],
    [right - radius, top + radius, -Math.PI / 2],
    [right - radius, bottom - radius, 0],
    [left + radius, bottom - radius, Math.PI / 2],
  ]) {
    const segments = 24
    for (let step = 0; step < segments; step += 1) {
      const a1 = start + (Math.PI / 2) * (step / segments)
      const a2 = start + (Math.PI / 2) * ((step + 1) / segments)
      line(cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius, cx + Math.cos(a2) * radius, cy + Math.sin(a2) * radius, width, color, alpha)
    }
  }
}

const INK = [232, 232, 234]
const ACCENT = [77, 141, 255]
const DEEP = [27, 27, 31]

// 所有坐标都在 DESIGN(=256) 的设计空间里书写，再乘 S 缩放到实际尺寸。
// 这样改尺寸不会牵动绘图逻辑，也让"设计意图"与"输出分辨率"分开。
const px = (v) => v * S

// Rounded square plate.
roundedFrame(px(18), px(18), px(DESIGN - 18), px(DESIGN - 18), px(46), px(14), DEEP, 1)
roundedFrame(px(18), px(18), px(DESIGN - 18), px(DESIGN - 18), px(46), px(4), ACCENT, 0.95)

// Harness node graph: two left nodes feeding one right node.
const left = [px(86), px(112)]
const mid = [px(86), px(144)]
const right = [px(170), px(128)]
line(left[0], left[1], right[0], right[1], px(7), INK, 0.9)
line(mid[0], mid[1], right[0], right[1], px(7), INK, 0.9)
line(left[0], left[1], mid[0], mid[1], px(5), INK, 0.35)
disc(left[0], left[1], px(15), INK)
disc(mid[0], mid[1], px(15), INK)
disc(right[0], right[1], px(21), ACCENT)

/** Encode the canvas as a PNG. */
function encodePng() {
  const stride = SIZE * 4
  const raw = Buffer.alloc((stride + 1) * SIZE)
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc ^ 0xffffffff
}

mkdirSync(OUT_DIR, { recursive: true })
const out = join(OUT_DIR, 'icon.png')
writeFileSync(out, encodePng())
console.log(`[generate-icon] wrote ${out} (${SIZE}x${SIZE})`)
