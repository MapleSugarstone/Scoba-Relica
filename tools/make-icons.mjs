// Generates the home-screen icons from a sprite in `assets/`.
// Run with `node tools/make-icons.mjs`; the PNGs it writes into `public/icons`
// are committed, so a build needs no image tooling. Scaling is integer
// nearest-neighbour, because every pixel of this art is placed by hand.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "assets/Scobas/Relica.png");
const OUT_DIR = resolve(ROOT, "public/icons");
const BG = [0x2a, 0x30, 0x49]; // matches <meta name="theme-color">

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Decode a non-interlaced PNG to flat RGBA. Covers the colour types the art uses. */
function decodePng(buf) {
  const chunks = {};
  const idat = [];
  let o = 8;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IDAT") idat.push(data);
    else chunks[type] = data;
    o += 12 + len;
  }
  const ihdr = chunks["IHDR"];
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const color = ihdr[9];
  if (ihdr[12] !== 0) throw new Error("interlaced PNG not supported");
  if (depth !== 8 && color !== 3) throw new Error(`bit depth ${depth} only supported for palette images`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) throw new Error(`colour type ${color} not supported`);
  const bpp = Math.max(1, (channels * depth) >> 3);
  const rowBytes = Math.ceil((channels * depth * w) / 8);
  const raw = inflateSync(Buffer.concat(idat));

  // Undo the per-row filters (PNG spec 9.2), top to bottom: each row may
  // reference the reconstructed bytes to its left and in the row above.
  const px = Buffer.alloc(h * rowBytes);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const src = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    const line = px.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? px.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
  }

  const plte = chunks["PLTE"];
  const trns = chunks["tRNS"];
  const out = Buffer.alloc(w * h * 4);
  const sample = (line, i) => {
    if (depth === 8) return line[i];
    const per = 8 / depth;
    const byte = line[Math.floor(i / per)];
    const shift = 8 - depth * ((i % per) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  for (let y = 0; y < h; y++) {
    const line = px.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      if (color === 3) {
        const idx = sample(line, x);
        out[d] = plte[idx * 3];
        out[d + 1] = plte[idx * 3 + 1];
        out[d + 2] = plte[idx * 3 + 2];
        out[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (color === 0 || color === 4) {
        const s = x * channels;
        out[d] = line[s];
        out[d + 1] = line[s];
        out[d + 2] = line[s];
        out[d + 3] = color === 4 ? line[s + 1] : 255;
      } else {
        const s = x * channels;
        out[d] = line[s];
        out[d + 1] = line[s + 1];
        out[d + 2] = line[s + 2];
        out[d + 3] = color === 6 ? line[s + 3] : 255;
      }
    }
  }
  return { w, h, px: out };
}

/** Encode opaque RGB. Icons never want alpha: iOS flattens it to black anyway. */
function encodePng(w, h, rgb) {
  const rowBytes = w * 3;
  const raw = Buffer.alloc(h * (rowBytes + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (rowBytes + 1)] = 0;
    rgb.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Drop fully transparent rows and columns so the sprite fills the icon. */
function trim(img) {
  let x0 = img.w;
  let y0 = img.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.px[(y * img.w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return img;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    img.px.copy(px, y * w * 4, ((y + y0) * img.w + x0) * 4, ((y + y0) * img.w + x0 + w) * 4);
  }
  return { w, h, px };
}

/**
 * Draw the sprite centred on a flat background, scaled by the largest integer
 * factor that keeps it inside `coverage` of the canvas. An integer factor is
 * the point: a fractional one would blur the pixel grid.
 */
function render(sprite, size, coverage) {
  const budget = size * coverage;
  const scale = Math.max(1, Math.floor(Math.min(budget / sprite.w, budget / sprite.h)));
  const dw = sprite.w * scale;
  const dh = sprite.h * scale;
  const ox = Math.round((size - dw) / 2);
  const oy = Math.round((size - dh) / 2);
  const rgb = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    rgb[i * 3] = BG[0];
    rgb[i * 3 + 1] = BG[1];
    rgb[i * 3 + 2] = BG[2];
  }
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const s = (Math.floor(y / scale) * sprite.w + Math.floor(x / scale)) * 4;
      const a = sprite.px[s + 3] / 255;
      if (a === 0) continue;
      const d = ((y + oy) * size + (x + ox)) * 3;
      for (let c = 0; c < 3; c++) rgb[d + c] = Math.round(sprite.px[s + c] * a + rgb[d + c] * (1 - a));
    }
  }
  return encodePng(size, size, rgb);
}

const sprite = trim(decodePng(readFileSync(SOURCE)));
mkdirSync(OUT_DIR, { recursive: true });

// An "any" icon is shown whole, so it can run close to the edge. A maskable
// icon is cropped to whatever shape the launcher wants, and only the middle
// 80% survives everywhere, so its art stays well inside that.
const ICONS = [
  ["icon-192.png", 192, 0.78],
  ["icon-512.png", 512, 0.78],
  ["icon-maskable-512.png", 512, 0.56],
  ["apple-touch-icon-180.png", 180, 0.74],
];

for (const [name, size, coverage] of ICONS) {
  const png = render(sprite, size, coverage);
  writeFileSync(resolve(OUT_DIR, name), png);
  console.log(`${name.padEnd(26)} ${size}x${size}  ${String(png.length).padStart(6)} bytes`);
}
console.log(`source sprite trimmed to ${sprite.w}x${sprite.h}`);
