/* A small QR encoder, byte mode, versions 1-10.
 *
 * Only what a room link needs: a short ASCII URL, error correction level M, and
 * a boolean matrix to draw. Correctness here is not a matter of taste — the
 * test suite renders the output and decodes it with a real reader, so a broken
 * mask or a misplaced codeword fails the build rather than the game night.
 */
function Flip7QR(){
  "use strict";

  /* Data codeword capacity and error-correction blocks, level M, versions 1-10.
     [total data codewords, ecc codewords per block, blocks in group 1,
      data codewords per block in group 1, blocks in group 2, data per block]. */
  var SPEC = {
    1:  [16,  10, 1, 16, 0, 0],
    2:  [28,  16, 1, 28, 0, 0],
    3:  [44,  26, 1, 44, 0, 0],
    4:  [64,  18, 2, 32, 0, 0],
    5:  [86,  24, 2, 43, 0, 0],
    6:  [108, 16, 4, 27, 0, 0],
    7:  [124, 18, 4, 31, 0, 0],
    8:  [154, 22, 2, 38, 2, 39],
    9:  [182, 22, 3, 36, 2, 37],
    10: [216, 26, 4, 43, 1, 44]
  };

  /* Row/column centres of the alignment patterns, by version. */
  var ALIGN = {
    1: [], 2: [6,18], 3: [6,22], 4: [6,26], 5: [6,30],
    6: [6,34], 7: [6,22,38], 8: [6,24,42], 9: [6,26,46], 10: [6,28,50]
  };

  /* ---------- GF(256) ---------- */
  var EXP = new Array(512), LOG = new Array(256);
  (function(){
    var x = 1;
    for(var i = 0; i < 255; i++){
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if(x & 0x100) x ^= 0x11d;
    }
    for(var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b){
    if(a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* Generator polynomial for n ecc codewords. */
  function generator(n){
    var poly = [1];
    for(var i = 0; i < n; i++){
      var next = new Array(poly.length + 1).fill(0);
      for(var j = 0; j < poly.length; j++){
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function eccFor(data, n){
    var gen = generator(n);
    var rem = data.slice().concat(new Array(n).fill(0));
    for(var i = 0; i < data.length; i++){
      var factor = rem[i];
      if(factor === 0) continue;
      for(var j = 0; j < gen.length; j++) rem[i + j] ^= gmul(gen[j], factor);
    }
    return rem.slice(data.length);
  }

  /* ---------- bit stream ---------- */
  function Bits(){
    this.bits = [];
  }
  Bits.prototype.push = function(value, length){
    for(var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  /* ---------- format information ---------- */
  /* Level M is 00 in the two high bits; mask goes in the low three. */
  function formatBits(mask){
    var data = (0 << 3) | mask;          // 00 = level M
    var rem = data << 10;
    for(var i = 14; i >= 10; i--){
      if((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
    }
    return ((data << 10) | rem) ^ 0x5412;
  }

  function versionBits(version){
    if(version < 7) return null;
    var rem = version << 12;
    for(var i = 17; i >= 12; i--){
      if((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
    }
    return (version << 12) | rem;
  }

  /* ---------- matrix ---------- */
  function newMatrix(size){
    var m = [], r, c;
    for(r = 0; r < size; r++){
      m[r] = [];
      for(c = 0; c < size; c++) m[r][c] = null;   // null = free
    }
    return m;
  }

  function placeFinder(m, row, col){
    for(var r = -1; r <= 7; r++){
      for(var c = -1; c <= 7; c++){
        var rr = row + r, cc = col + c;
        if(rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        var on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                 (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                 (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[rr][cc] = on ? 1 : 0;
      }
    }
  }

  function placeAlignment(m, version){
    var centres = ALIGN[version];
    for(var i = 0; i < centres.length; i++){
      for(var j = 0; j < centres.length; j++){
        var row = centres[i], col = centres[j];
        if(m[row][col] !== null) continue;        // overlaps a finder
        for(var r = -2; r <= 2; r++){
          for(var c = -2; c <= 2; c++){
            var on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
            m[row + r][col + c] = on ? 1 : 0;
          }
        }
      }
    }
  }

  function placeTiming(m){
    for(var i = 8; i < m.length - 8; i++){
      var on = i % 2 === 0 ? 1 : 0;
      if(m[6][i] === null) m[6][i] = on;
      if(m[i][6] === null) m[i][6] = on;
    }
  }

  function reserveFormat(m){
    var size = m.length, i;
    for(i = 0; i <= 8; i++){
      if(m[8][i] === null) m[8][i] = 0;
      if(m[i][8] === null) m[i][8] = 0;
    }
    for(i = 0; i < 8; i++){
      if(m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
      if(m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
    }
    m[size - 8][8] = 1;                            // always-dark module
  }

  function reserveVersion(m, version){
    if(version < 7) return;
    var size = m.length;
    for(var i = 0; i < 18; i++){
      var r = Math.floor(i / 3), c = i % 3;
      m[size - 11 + c][r] = 0;
      m[r][size - 11 + c] = 0;
    }
  }

  /* Which modules were written by the function patterns above. */
  function reservedMap(version){
    var size = version * 4 + 17;
    var m = newMatrix(size);
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);
    placeAlignment(m, version);
    placeTiming(m);
    reserveFormat(m);
    reserveVersion(m, version);
    return m;
  }

  var MASKS = [
    function(r, c){ return (r + c) % 2 === 0; },
    function(r){ return r % 2 === 0; },
    function(r, c){ return c % 3 === 0; },
    function(r, c){ return (r + c) % 3 === 0; },
    function(r, c){ return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function(r, c){ return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function(r, c){ return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function(r, c){ return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
  ];

  /* Penalty scoring, so the chosen mask is the one the spec would choose. */
  function penalty(m){
    var size = m.length, score = 0, r, c, i;

    function run(getter){
      var total = 0;
      for(var a = 0; a < size; a++){
        var last = -1, len = 0;
        for(var b = 0; b < size; b++){
          var v = getter(a, b);
          if(v === last){ len++; }
          else { if(len >= 5) total += len - 2; last = v; len = 1; }
        }
        if(len >= 5) total += len - 2;
      }
      return total;
    }
    score += run(function(a, b){ return m[a][b]; });
    score += run(function(a, b){ return m[b][a]; });

    for(r = 0; r < size - 1; r++){
      for(c = 0; c < size - 1; c++){
        var v = m[r][c];
        if(v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    var pat1 = [1,0,1,1,1,0,1,0,0,0,0];
    var pat2 = [0,0,0,0,1,0,1,1,1,0,1];
    function matches(a, b, horizontal, pat){
      for(var k = 0; k < 11; k++){
        var v = horizontal ? m[a][b + k] : m[b + k][a];
        if(v !== pat[k]) return false;
      }
      return true;
    }
    for(r = 0; r < size; r++){
      for(c = 0; c + 11 <= size; c++){
        if(matches(r, c, true, pat1) || matches(r, c, true, pat2)) score += 40;
        if(matches(r, c, false, pat1) || matches(r, c, false, pat2)) score += 40;
      }
    }

    var dark = 0;
    for(r = 0; r < size; r++) for(c = 0; c < size; c++) if(m[r][c]) dark++;
    var pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  /* ---------- the encoder ---------- */
  function encode(text, forceMask){
    var bytes = [], i;
    for(i = 0; i < text.length; i++){
      var code = text.charCodeAt(i);
      if(code > 255) throw new Error("Only single-byte characters are supported here.");
      bytes.push(code);
    }

    /* Smallest version that fits, allowing for the longer length field from v10. */
    var version = 0;
    for(var v = 1; v <= 10; v++){
      var lenBits = v < 10 ? 8 : 16;
      var needed = 4 + lenBits + bytes.length * 8;
      if(SPEC[v][0] * 8 >= needed){ version = v; break; }
    }
    if(!version) throw new Error("That text is too long for this encoder.");

    var spec = SPEC[version];
    var totalData = spec[0], eccPer = spec[1];
    var g1 = spec[2], d1 = spec[3], g2 = spec[4], d2 = spec[5];

    var bs = new Bits();
    bs.push(4, 4);                                   // byte mode
    bs.push(bytes.length, version < 10 ? 8 : 16);
    for(i = 0; i < bytes.length; i++) bs.push(bytes[i], 8);

    var capacity = totalData * 8;
    var terminator = Math.min(4, capacity - bs.bits.length);
    bs.push(0, terminator);
    while(bs.bits.length % 8) bs.bits.push(0);

    var data = [];
    for(i = 0; i < bs.bits.length; i += 8){
      var b = 0;
      for(var k = 0; k < 8; k++) b = (b << 1) | bs.bits[i + k];
      data.push(b);
    }
    var pad = [0xec, 0x11], p = 0;
    while(data.length < totalData) data.push(pad[p++ % 2]);

    /* Split into blocks, compute ecc, then interleave. */
    var blocks = [], eccBlocks = [], at = 0;
    for(i = 0; i < g1; i++){ blocks.push(data.slice(at, at + d1)); at += d1; }
    for(i = 0; i < g2; i++){ blocks.push(data.slice(at, at + d2)); at += d2; }
    for(i = 0; i < blocks.length; i++) eccBlocks.push(eccFor(blocks[i], eccPer));

    var out = [], maxData = Math.max(d1, d2);
    for(i = 0; i < maxData; i++){
      for(var b2 = 0; b2 < blocks.length; b2++){
        if(i < blocks[b2].length) out.push(blocks[b2][i]);
      }
    }
    for(i = 0; i < eccPer; i++){
      for(var b3 = 0; b3 < eccBlocks.length; b3++) out.push(eccBlocks[b3][i]);
    }

    /* Lay the codewords into the free modules, bottom-right upward in pairs. */
    var reserved = reservedMap(version);
    var size = version * 4 + 17;
    var m = newMatrix(size);
    for(var r0 = 0; r0 < size; r0++)
      for(var c0 = 0; c0 < size; c0++) m[r0][c0] = reserved[r0][c0];

    var bitIndex = 0;
    function nextBit(){
      var byteAt = bitIndex >> 3;
      if(byteAt >= out.length) return 0;
      var bit = (out[byteAt] >>> (7 - (bitIndex & 7))) & 1;
      bitIndex++;
      return bit;
    }

    var upward = true;
    for(var col = size - 1; col > 0; col -= 2){
      if(col === 6) col--;                            // skip the timing column
      for(var step = 0; step < size; step++){
        var row = upward ? size - 1 - step : step;
        for(var offset = 0; offset < 2; offset++){
          var cc = col - offset;
          if(reserved[row][cc] !== null) continue;
          m[row][cc] = nextBit();
        }
      }
      upward = !upward;
    }

    /* Try every mask, keep the least penalised. */
    var best = null, bestScore = Infinity, bestMask = 0;
    for(var mask = 0; mask < 8; mask++){
      if(forceMask !== undefined && mask !== forceMask) continue;
      var cand = [];
      for(var r1 = 0; r1 < size; r1++){
        cand[r1] = [];
        for(var c1 = 0; c1 < size; c1++){
          var val = m[r1][c1];
          if(reserved[r1][c1] === null && MASKS[mask](r1, c1)) val ^= 1;
          cand[r1][c1] = val;
        }
      }
      writeFormat(cand, mask, version);
      var score = penalty(cand);
      if(score < bestScore){ bestScore = score; best = cand; bestMask = mask; }
    }
    return best;
  }

  function writeFormat(m, mask, version){
    var size = m.length;
    var fmt = formatBits(mask), i;
    /* Bit 0 is the least significant. The strip down column 8 and the strip
       along row 8 carry the same 15 bits in opposite directions. */
    for(i = 0; i < 15; i++){
      var bit = (fmt >>> i) & 1;
      if(i < 6) m[i][8] = bit;
      else if(i < 8) m[i + 1][8] = bit;
      else m[size - 15 + i][8] = bit;

      if(i < 8) m[8][size - 1 - i] = bit;
      else if(i === 8) m[8][7] = bit;
      else m[8][14 - i] = bit;
    }
    m[size - 8][8] = 1;

    var ver = versionBits(version);
    if(ver !== null){
      for(i = 0; i < 18; i++){
        var bit = (ver >>> i) & 1;
        var r = Math.floor(i / 3), c = i % 3;
        m[size - 11 + c][r] = bit;
        m[r][size - 11 + c] = bit;
      }
    }
  }

  return { encode: encode };
}
