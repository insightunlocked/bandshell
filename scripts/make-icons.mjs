// Generates the app icons as PNGs with no image dependencies — the artwork
// is drawn procedurally and encoded here (Node's zlib does the compression).
// Run via `npm run icons`; `npm run build` does it automatically.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BG = [0x20, 0x22, 0x26]; // studio charcoal, matches the app chrome
const BAR = [0x7a, 0xce, 0x6f]; // the region green
const BAR_ALT = [0x5e, 0xa9, 0x4f];
// Bar heights as a fraction of the icon — reads as a waveform even at 16px.
const BARS = [0.3, 0.55, 0.86, 0.44, 0.72, 0.36, 0.24];
const SS = 4; // supersampling factor for smooth edges

function drawIcon(size, padding) {
  const px = new Uint8Array(size * size * 4);
  const inner = size * (1 - padding * 2);
  const originX = size * padding;
  const radius = inner * 0.22;

  const barCount = BARS.length;
  const slot = inner / barCount;
  const barW = slot * 0.52;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let barHits = 0;
      let barShade = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px0 = x + (sx + 0.5) / SS;
          const py0 = y + (sy + 0.5) / SS;
          if (!inRoundedRect(px0, py0, originX, originX, inner, inner, radius)) continue;
          bgHits++;
          const i = Math.floor((px0 - originX) / slot);
          if (i < 0 || i >= barCount) continue;
          const cx = originX + (i + 0.5) * slot;
          if (Math.abs(px0 - cx) > barW / 2) continue;
          const h = inner * BARS[i];
          const midY = originX + inner / 2;
          if (py0 < midY - h / 2 || py0 > midY + h / 2) continue;
          if (!inRoundedRect(px0, py0, cx - barW / 2, midY - h / 2, barW, h, barW / 2)) continue;
          barHits++;
          barShade += (py0 - (midY - h / 2)) / h; // subtle vertical gradient
        }
      }
      const total = SS * SS;
      const o = (y * size + x) * 4;
      if (!bgHits) {
        px[o + 3] = 0; // transparent outside the rounded square
        continue;
      }
      const barA = barHits / total;
      const shade = barHits ? barShade / barHits : 0;
      const bar = mix(BAR, BAR_ALT, shade);
      for (let c = 0; c < 3; c++) {
        px[o + c] = Math.round(BG[c] * (1 - barA) + bar[c] * barA);
      }
      px[o + 3] = Math.round(255 * (bgHits / total));
    }
  }
  return px;
}

function mix(a, b, t) {
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);
}

function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// --- minimal PNG encoder (RGBA, no interlace) ---

const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const targets = [
  { file: "public/icons/icon-192.png", size: 192, padding: 0.04 },
  { file: "public/icons/icon-512.png", size: 512, padding: 0.04 },
  // Maskable icons get extra padding so platform shape masks don't clip them.
  { file: "public/icons/icon-maskable-512.png", size: 512, padding: 0.16 },
  { file: "public/icons/apple-touch-icon.png", size: 180, padding: 0.04 },
  { file: "public/favicon.png", size: 64, padding: 0.02 },
];

for (const t of targets) {
  const out = resolve(ROOT, t.file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodePng(drawIcon(t.size, t.padding), t.size));
  console.log("wrote", t.file);
}
