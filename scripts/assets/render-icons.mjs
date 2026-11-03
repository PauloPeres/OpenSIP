// Renders build/icon.png, build/icon.iconset/** and build/icon.icns from assets/logo-mark.svg.
// Run: npx electron scripts/assets/render-icons.mjs
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const build = join(root, 'build')
const iconset = join(build, 'icon.iconset')
const ACCENT = '#0E9F8E'

// macOS-style tile: straight edges joined to corners that ease in with continuous curvature.
// L = 320 / n = 3.0 on the 824px tile were fitted against the Notes.app icon outline.
// Each corner is a superellipse quadrant (exponent n) spanning L px along each edge, so curvature
// goes to zero where it meets the straight edge (like the Big Sur+ icon mask, unlike a plain
// rounded rect). Sampled, then emitted as smooth cubic Beziers (Catmull-Rom -> Bezier).
function squircle(cx, cy, half, L, n = 3.0, perCorner = 12) {
  const pts = []
  const f = (v) => +v.toFixed(2)
  const corners = [[1, -1], [1, 1], [-1, 1], [-1, -1]] // TR, BR, BL, TL (clockwise)
  for (const [sx, sy] of corners) {
    const ox = cx + sx * (half - L), oy = cy + sy * (half - L)
    for (let i = 0; i <= perCorner; i++) {
      const t = (i / perCorner) * (Math.PI / 2)
      const u = Math.cos(t) ** (2 / n), v = Math.sin(t) ** (2 / n)
      const [px, py] = sx > 0 && sy < 0 ? [ox + L * v, oy - L * u]
        : sx > 0 && sy > 0 ? [ox + L * u, oy + L * v]
        : sx < 0 && sy > 0 ? [ox - L * v, oy + L * u]
        : [ox - L * u, oy - L * v]
      pts.push([px, py])
    }
    pts.push(null) // marker: straight-edge filler points are inserted below
  }
  // insert edge fillers (3 per edge) at each null marker
  const out = []
  for (let i = 0; i < pts.length; i++) {
    if (pts[i]) { out.push(pts[i]); continue }
    const A = pts[i - 1], B = pts[(i + 1) % pts.length]
    for (let k = 1; k <= 3; k++) out.push([A[0] + ((B[0] - A[0]) * k) / 4, A[1] + ((B[1] - A[1]) * k) / 4])
  }
  const N = out.length
  let d = `M${f(out[0][0])} ${f(out[0][1])}`
  for (let i = 0; i < N; i++) {
    const p0 = out[(i - 1 + N) % N], p1 = out[i], p2 = out[(i + 1) % N], p3 = out[(i + 2) % N]
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`
  }
  return d + 'Z'
}

// Large icon (>= 64 px) = accent tile (824px in a 1024 canvas, 100px margins) + white three-bar mark.
const mark = readFileSync(join(root, 'assets', 'logo-mark.svg'), 'utf8')
const markPaths = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replaceAll(ACCENT, '#FFFFFF')
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<path d="${squircle(512, 512, 412, 320, 3.0, 14)}" fill="${ACCENT}"/>
<g transform="translate(128 122) scale(12)">${markPaths}</g></svg>`

// Small icons (16 and 32 px) are redrawn, not rescaled: fewer elements (ONE centre bar), and every
// edge is on a whole pixel of the target size. viewBox units == output pixels.
const small = (px) => {
  const k = px / 16
  const q = (v) => v * k
  const r = k // bar corner radius: half the bar width
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}">
<path d="${squircle(px / 2, px / 2, px / 2 - k, (px - 2 * k) * 0.388, 3.0, 6)}" fill="${ACCENT}"/>
<circle cx="${q(8)}" cy="${q(7)}" r="${q(4.5)}" fill="#FFFFFF"/>
<path d="M${q(4.1)} ${q(9.25)}L${q(3)} ${q(13.5)}L${q(8)} ${q(11.5)}Z" fill="#FFFFFF"/>
<rect x="${q(7)}" y="${q(4)}" width="${q(2)}" height="${q(6)}" rx="${r}" fill="${ACCENT}"/></svg>`
}

const sizes = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]
]

app.disableHardwareAcceleration()
setTimeout(() => { console.error('render timed out'); app.exit(1) }, 60000)
// Offscreen rendering always paints at device scale factor 1, so CSS px === output px.
const sf = 1
let win

async function render(px) {
  const svg = px <= 32 ? small(px) : iconSvg
  const css = px / sf
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden"><img style="display:block;width:${css}px;height:${css}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'))
  await new Promise((r) => setTimeout(r, 150))
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: css, height: css })
  const s = img.getSize()
  if (s.width !== px) img = img.resize({ width: px, height: px, quality: 'best' })
  return img.toPNG()
}

async function main() {
  await app.whenReady()
  win = new BrowserWindow({ show: false, transparent: true, frame: false, width: 1100, height: 1100, webPreferences: { offscreen: true } })
  try {
    rmSync(iconset, { recursive: true, force: true })
    mkdirSync(iconset, { recursive: true })
    const cache = new Map()
    for (const [name, px] of sizes) {
      if (!cache.has(px)) cache.set(px, await render(px))
      writeFileSync(join(iconset, name), cache.get(px))
    }
    writeFileSync(join(build, 'icon.png'), cache.get(1024))
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(build, 'icon.icns')], { stdio: 'inherit' })
    console.log('icons written to', build)
  } finally {
    app.quit()
  }
}

main().catch((e) => { console.error(e); app.exit(1) })
