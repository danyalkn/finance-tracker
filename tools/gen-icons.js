// Generate the app icons procedurally — no image libraries, no network.
// Motif: a brass "coin" on warm charcoal with a small wedge removed, like a
// pie/budget that is being depleted. Matches the app's palette.
//
// Run:  npm run gen-icons   (or: node tools/gen-icons.js)
// Output PNGs are committed to public/icons so the PWA needs no build step.

import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ---- palette (R,G,B) ----------------------------------------------------
const BG = [26, 23, 20]; // #1A1714 warm charcoal
const BRASS = [224, 178, 74]; // #E0B24A
const BRASS_DARK = [168, 128, 46]; // minted-ring detail

// ---- tiny PNG encoder (RGBA, no filtering) -----------------------------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // bytes 10..12 already 0 (compression / filter / interlace)

  // prepend a 0 (no-filter) byte to each scanline
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- scene --------------------------------------------------------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

// Color of a single sub-sample at (x, y) for an icon of the given size.
// coinR is the coin radius as a fraction of size (smaller => more padding,
// needed for maskable safe zones).
function sampleColor(x, y, size, coinR) {
  const cx = size / 2;
  const cy = size / 2;
  const R = size * coinR;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy);

  // outside the coin
  if (dist > R + 1) return BG;

  // angle measured from 12 o'clock, clockwise, in [-PI, PI]
  const ang = Math.atan2(dx, -dy);
  const deg = (ang * 180) / Math.PI;

  // the depletion wedge (a slice "spent" out of the top-right of the coin)
  const inWedge = deg > 6 && deg < 58;

  // base coin color, with a thin minted ring for detail
  let col = BRASS;
  const ringOuter = R * 0.9;
  const ringInner = R * 0.82;
  if (dist > ringInner && dist < ringOuter) col = BRASS_DARK;

  if (inWedge) col = BG; // the bite

  // antialias the outer edge (1px feather)
  const edge = clamp01(R - dist + 0.5);
  return mix(BG, col, edge);
}

function renderIcon(size, coinR) {
  const SS = 3; // 3x3 supersampling for smooth edges
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sampleColor(
            x + (sx + 0.5) / SS,
            y + (sy + 0.5) / SS,
            size,
            coinR,
          );
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = 255; // opaque (iOS dislikes transparent home-screen icons)
    }
  }
  return encodePNG(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, coinR: 0.42 },
  { file: 'icon-512.png', size: 512, coinR: 0.42 },
  // maskable: smaller coin so it survives platform mask cropping (safe zone)
  { file: 'icon-512-maskable.png', size: 512, coinR: 0.32 },
  // iOS home-screen icon (Add to Home Screen); iOS applies its own rounding
  { file: 'apple-touch-icon.png', size: 180, coinR: 0.42 },
  { file: 'favicon-32.png', size: 32, coinR: 0.42 },
];

for (const t of targets) {
  const png = renderIcon(t.size, t.coinR);
  writeFileSync(join(OUT_DIR, t.file), png);
  console.log(`wrote ${t.file} (${t.size}x${t.size}, ${png.length} bytes)`);
}
console.log('done.');
