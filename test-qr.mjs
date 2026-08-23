/* The QR encoder is only worth shipping if a real reader can read it, so this
 * renders each code to pixels and decodes it with jsQR. */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const jsQR = require("jsqr").default || require("jsqr");

/* Load the browser-side encoder as plain script text. */
const src = readFileSync("src/qr.js", "utf8");
const Flip7QR = new Function(src + "; return Flip7QR;")();
const QR = Flip7QR();

let pass = 0, fail = 0;
const check = (l, c, d) => c ? (pass++, console.log("  PASS  " + l))
                             : (fail++, console.log("  FAIL  " + l + (d ? "  -> " + d : "")));

/* Blow the matrix up with a quiet zone, as a screen would render it. */
function toImage(matrix, scale = 4, quiet = 4){
  const size = matrix.length;
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for(let r = 0; r < size; r++){
    for(let c = 0; c < size; c++){
      if(!matrix[r][c]) continue;
      for(let y = 0; y < scale; y++){
        for(let x = 0; x < scale; x++){
          const py = (r + quiet) * scale + y, px = (c + quiet) * scale + x;
          const i = (py * dim + px) * 4;
          data[i] = data[i+1] = data[i+2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

function roundTrip(text){
  const m = QR.encode(text);
  const img = toImage(m);
  const got = jsQR(img.data, img.width, img.height);
  return { decoded: got && got.data, size: m.length };
}

console.log("\nQR encoder — decoded with a real reader, not eyeballed\n");

const cases = [
  "https://flip7-scorekeeper-719283.gitlab.io/#room=5SQQ",
  "https://flip7-scorekeeper-719283.gitlab.io/#room=ABCD",
  "HELLO",
  "https://flip7-scorekeeper-719283.gitlab.io/#room=WS7T&relay=https%3A%2F%2Fflip7-relay.sstangle73.workers.dev",
  "x".repeat(100)
];
for(const text of cases){
  const { decoded, size } = roundTrip(text);
  check(`decodes ${size}x${size}: ${text.slice(0, 46)}${text.length > 46 ? "…" : ""}`,
    decoded === text, decoded === null ? "reader could not find a code" : "got " + JSON.stringify(decoded));
}

/* Every room code the relay can mint must encode cleanly. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let bad = 0, tried = 0;
for(let i = 0; i < ALPHABET.length; i++){
  const code = ALPHABET[i] + ALPHABET[(i * 7) % 32] + ALPHABET[(i * 13) % 32] + ALPHABET[(i * 29) % 32];
  const url = "https://flip7-scorekeeper-719283.gitlab.io/#room=" + code;
  tried++;
  if(roundTrip(url).decoded !== url) bad++;
}
check(`all ${tried} sampled room links decode`, bad === 0, bad + " failed");

console.log(`\n${pass} passed, ${fail} failed\n`);
/* Sweep lengths so every supported version, and the version-info blocks that
   appear from version 7, get exercised. */
const sizes = new Set();
const sweepBad = [];
for(let len = 1; len <= 200; len += 7){
  const text = "A".repeat(len);
  const { decoded, size } = roundTrip(text);
  sizes.add(size);
  if(decoded !== text) sweepBad.push(len);
}
check(`lengths 1-200 all decode across ${sizes.size} versions`, sweepBad.length === 0,
  "failed at lengths " + sweepBad.join(","));
console.log("        sizes covered: " + [...sizes].sort((a,b)=>a-b).join(", "));

let threw = false;
try { QR.encode("A".repeat(400)); } catch(e){ threw = /too long/i.test(e.message); }
check("over-long input is refused, not mangled", threw);

console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
