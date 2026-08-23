/* Generates the PWA icons.
 *
 * Run with `node tools/make-icons.mjs` after changing anything here; the PNGs
 * are committed so build.sh stays dependency-free.
 *
 * The mark is the tilted gold card from the wordmark with a 7 knocked out of
 * it. The 7 is one closed polygon rather than a bar plus a separate diagonal,
 * so the join at the top right is exact instead of nearly meeting. Everything
 * is supersampled, because a jagged edge is very visible at 192px on a phone.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

/* ---------- PNG writer ---------- */
const CRC = (() => {
  const t = new Uint32Array(256);
  for(let n = 0; n < 256; n++){
    let c = n;
    for(let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf){
  let c = 0xffffffff;
  for(const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, shade){
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for(let y = 0; y < size; y++){
    raw[y * (size * 4 + 1)] = 0;
    for(let x = 0; x < size; x++){
      const [r, g, b] = shade(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---------- the mark ---------- */
const NAVY  = [13, 23, 41];
const GOLD  = [184, 114, 9];
const CREAM = [255, 253, 246];

const TILT = -0.11;                 // matches the wordmark's tilted 7 tile
const CARD_W = 0.24, CARD_H = 0.31; // half-extents; keeps corners inside the
const CARD_R = 0.045;               // maskable safe circle

/* One closed outline, walked clockwise. The bar's top-right corner flows
   straight into the diagonal, which is the join that was previously open. */
const SEVEN = [
  [0.200, 0.150],   // bar, top left
  [0.800, 0.150],   // bar, top right -- the diagonal starts here
  [0.500, 0.870],   // tip, outer
  [0.330, 0.870],   // tip, inner
  [0.572, 0.290],   // diagonal's inner edge, back up to the bar
  [0.200, 0.290]    // bar, bottom left
];

function inPolygon(px, py, poly){
  let inside = false;
  for(let i = 0, j = poly.length - 1; i < poly.length; j = i++){
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi){
      inside = !inside;
    }
  }
  return inside;
}

/* Rounded rectangle, negative inside. */
function roundedRect(px, py, hw, hh, r){
  const dx = Math.abs(px) - (hw - r), dy = Math.abs(py) - (hh - r);
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

function sampleAt(u, v){
  const cx = u - 0.5, cy = v - 0.5;
  const rx = cx * Math.cos(TILT) - cy * Math.sin(TILT);
  const ry = cx * Math.sin(TILT) + cy * Math.cos(TILT);
  if(roundedRect(rx, ry, CARD_W, CARD_H, CARD_R) > 0) return NAVY;
  const nx = (rx + CARD_W) / (CARD_W * 2);
  const ny = (ry + CARD_H) / (CARD_H * 2);
  return inPolygon(nx, ny, SEVEN) ? CREAM : GOLD;
}

/* 4x4 supersampling: cheap, and the difference at 192px is obvious. */
const SS = 4;
function shade(x, y, size){
  let r = 0, g = 0, b = 0;
  for(let sy = 0; sy < SS; sy++){
    for(let sx = 0; sx < SS; sx++){
      const c = sampleAt((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
      r += c[0]; g += c[1]; b += c[2];
    }
  }
  const n = SS * SS;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

for(const size of [180, 192, 512]){
  writeFileSync(`icon-${size}.png`, png(size, shade));
  console.log(`wrote icon-${size}.png`);
}
