// ============================================================================
// gifEncoder.js — Pure-JS Spec-Compliant GIF89a Encoder
// Features: Fast 5-bit RGB Median-Cut 256-color quantization, O(1) LUT pixel
// mapping, LZW variable-code compression (9..12-bit), NETSCAPE2.0 looping.
// ============================================================================

class ByteBuffer {
  constructor(initialSize = 65536) {
    this.buf = new Uint8Array(initialSize);
    this.len = 0;
  }
  ensure(extra) {
    if (this.len + extra <= this.buf.length) return;
    let nextSize = this.buf.length * 2;
    while (nextSize < this.len + extra) nextSize *= 2;
    const next = new Uint8Array(nextSize);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  writeByte(b) {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }
  writeShortLE(v) {
    this.ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >> 8) & 0xff;
  }
  writeString(str) {
    this.ensure(str.length);
    for (let i = 0; i < str.length; i++) {
      this.buf[this.len++] = str.charCodeAt(i) & 0xff;
    }
  }
  writeBytes(arr, offset = 0, count = arr.length) {
    this.ensure(count);
    this.buf.set(arr.subarray(offset, offset + count), this.len);
    this.len += count;
  }
  toUint8Array() {
    return this.buf.slice(0, this.len);
  }
}

/**
 * Median-Cut quantizer operating on 5-bit RGB histogram (32,768 bins).
 * Returns { palette: Uint8Array(768), lut: Uint8Array(32768) }.
 */
function quantizeFrameRGBA(rgba, width, height) {
  const hist = new Uint32Array(32768);
  const pixelCount = width * height;
  const stride = pixelCount > 200000 ? 2 : 1;

  for (let i = 0; i < pixelCount; i += stride) {
    const o = i * 4;
    const r = rgba[o] >> 3;
    const g = rgba[o + 1] >> 3;
    const b = rgba[o + 2] >> 3;
    hist[(r << 10) | (g << 5) | b]++;
  }

  // Collect non-empty bins
  const bins = [];
  for (let idx = 0; idx < 32768; idx++) {
    const count = hist[idx];
    if (count > 0) {
      bins.push({
        idx,
        r: (idx >> 10) & 31,
        g: (idx >> 5) & 31,
        b: idx & 31,
        count,
      });
    }
  }

  if (bins.length === 0) {
    return {
      palette: new Uint8Array(768),
      lut: new Uint8Array(32768),
    };
  }

  const makeBox = (list) => {
    let rMin = 31, rMax = 0, gMin = 31, gMax = 0, bMin = 31, bMax = 0;
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.r < rMin) rMin = c.r;
      if (c.r > rMax) rMax = c.r;
      if (c.g < gMin) gMin = c.g;
      if (c.g > gMax) gMax = c.g;
      if (c.b < bMin) bMin = c.b;
      if (c.b > bMax) bMax = c.b;
      total += c.count;
    }
    const rRange = rMax - rMin;
    const gRange = gMax - gMin;
    const bRange = bMax - bMin;
    const maxRange = Math.max(rRange, gRange, bRange);
    return {
      list,
      total,
      rRange,
      gRange,
      bRange,
      score: maxRange * Math.log2(total + 1),
    };
  };

  const boxes = [makeBox(bins)];
  const maxColors = 256;

  while (boxes.length < maxColors) {
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.list.length > 1 && box.score > bestScore) {
        bestScore = box.score;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;

    const box = boxes[bestIdx];
    const list = box.list;
    if (box.gRange >= box.rRange && box.gRange >= box.bRange) {
      list.sort((a, b) => a.g - b.g);
    } else if (box.rRange >= box.bRange) {
      list.sort((a, b) => a.r - b.r);
    } else {
      list.sort((a, b) => a.b - b.b);
    }

    const half = box.total * 0.5;
    let acc = 0;
    let split = 1;
    for (let i = 0; i < list.length - 1; i++) {
      acc += list[i].count;
      if (acc >= half) {
        split = i + 1;
        break;
      }
    }

    const left = list.slice(0, split);
    const right = list.slice(split);
    boxes[bestIdx] = makeBox(left);
    boxes.push(makeBox(right));
  }

  const palette = new Uint8Array(768);
  const lut = new Uint8Array(32768);
  const palR = new Int32Array(boxes.length);
  const palG = new Int32Array(boxes.length);
  const palB = new Int32Array(boxes.length);

  for (let i = 0; i < boxes.length; i++) {
    const list = boxes[i].list;
    let sr = 0, sg = 0, sb = 0, tot = 0;
    for (let j = 0; j < list.length; j++) {
      const c = list[j];
      sr += ((c.r << 3) | (c.r >> 2)) * c.count;
      sg += ((c.g << 3) | (c.g >> 2)) * c.count;
      sb += ((c.b << 3) | (c.b >> 2)) * c.count;
      tot += c.count;
      lut[c.idx] = i;
    }
    const r = Math.round(sr / tot);
    const g = Math.round(sg / tot);
    const b = Math.round(sb / tot);
    palette[i * 3] = r;
    palette[i * 3 + 1] = g;
    palette[i * 3 + 2] = b;
    palR[i] = r;
    palG[i] = g;
    palB[i] = b;
  }

  // If stride > 1, ensure any unvisited bins map to nearest palette entry
  if (stride > 1) {
    const numColors = boxes.length;
    for (let i = 0; i < pixelCount; i++) {
      const o = i * 4;
      const r5 = rgba[o] >> 3;
      const g5 = rgba[o + 1] >> 3;
      const b5 = rgba[o + 2] >> 3;
      const idx = (r5 << 10) | (g5 << 5) | b5;
      if (hist[idx] === 0) {
        const r8 = (r5 << 3) | (r5 >> 2);
        const g8 = (g5 << 3) | (g5 >> 2);
        const b8 = (b5 << 3) | (b5 >> 2);
        let bestD = 1e9, bestC = 0;
        for (let c = 0; c < numColors; c++) {
          const dr = r8 - palR[c];
          const dg = g8 - palG[c];
          const db = b8 - palB[c];
          const d = dr * dr + dg * dg + db * db;
          if (d < bestD) {
            bestD = d;
            bestC = c;
          }
        }
        lut[idx] = bestC;
        hist[idx] = 1;
      }
    }
  }

  return { palette, lut };
}

/**
 * LZW encoder for 8-bit indexed pixel stream (minCodeSize = 8).
 * Uses a fast open-addressed hash table (size 5003) for O(1) dictionary lookup.
 */
function writeLZW(out, indices, minCodeSize = 8) {
  out.writeByte(minCodeSize);

  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const HASH_SIZE = 5003;
  const hashKey = new Int32Array(HASH_SIZE);
  const hashVal = new Int16Array(HASH_SIZE);
  hashKey.fill(-1);

  let nextCode = eoiCode + 1;
  let codeSize = minCodeSize + 1;
  let maxCode = 1 << codeSize;

  let bitBuf = 0;
  let bitCount = 0;
  const subBlock = new Uint8Array(256);
  let subLen = 0;

  const flushSubBlock = () => {
    if (subLen > 0) {
      out.writeByte(subLen);
      out.writeBytes(subBlock, 0, subLen);
      subLen = 0;
    }
  };

  const emitCode = (code) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      subBlock[subLen++] = bitBuf & 0xff;
      if (subLen === 255) flushSubBlock();
      bitBuf >>= 8;
      bitCount -= 8;
    }
  };

  const resetTable = () => {
    hashKey.fill(-1);
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
    maxCode = 1 << codeSize;
  };

  emitCode(clearCode);

  const n = indices.length;
  if (n > 0) {
    let prefix = indices[0];
    for (let i = 1; i < n; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      let h = ((k << 4) ^ prefix) % HASH_SIZE;
      if (h < 0) h += HASH_SIZE;
      const step = h === 0 ? 1 : HASH_SIZE - h;

      let found = -1;
      while (true) {
        const hk = hashKey[h];
        if (hk === key) {
          found = hashVal[h];
          break;
        }
        if (hk === -1) break;
        h -= step;
        if (h < 0) h += HASH_SIZE;
      }

      if (found !== -1) {
        prefix = found;
      } else {
        emitCode(prefix);
        if (nextCode < 4096) {
          hashKey[h] = key;
          hashVal[h] = nextCode;
          if (nextCode === maxCode && codeSize < 12) {
            codeSize++;
            maxCode = 1 << codeSize;
          }
          nextCode++;
        } else {
          emitCode(clearCode);
          resetTable();
        }
        prefix = k;
      }
    }
    emitCode(prefix);
  }

  emitCode(eoiCode);
  if (bitCount > 0) {
    subBlock[subLen++] = bitBuf & 0xff;
    bitCount = 0;
  }
  flushSubBlock();
  out.writeByte(0); // Block terminator
}

export class GifEncoder {
  constructor(width, height, repeat = 0) {
    this.width = width;
    this.height = height;
    this.repeat = repeat; // 0 = infinite loop
    this.out = new ByteBuffer(Math.max(65536, width * height * 2));
    this.started = false;
    this.frameCount = 0;
    this.indicesBuf = new Uint8Array(width * height);
  }

  _writeHeader() {
    const o = this.out;
    o.writeString('GIF89a');
    // Logical Screen Descriptor
    o.writeShortLE(this.width);
    o.writeShortLE(this.height);
    o.writeByte(0x70); // No Global Color Table, 8-bit color resolution
    o.writeByte(0);    // Background color index
    o.writeByte(0);    // Pixel aspect ratio

    // NETSCAPE2.0 Application Extension for looping
    if (this.repeat >= 0) {
      o.writeByte(0x21); // Extension Introducer
      o.writeByte(0xff); // Application Extension Label
      o.writeByte(11);   // Block Size
      o.writeString('NETSCAPE2.0');
      o.writeByte(3);    // Sub-block size
      o.writeByte(1);    // Loop sub-block ID
      o.writeShortLE(this.repeat);
      o.writeByte(0);    // Block terminator
    }
    this.started = true;
  }

  /**
   * Add a frame from RGBA Uint8ClampedArray / Uint8Array.
   * @param {Uint8ClampedArray|Uint8Array} rgba
   * @param {number} delayMs Frame display delay in milliseconds
   */
  addFrame(rgba, delayMs = 60) {
    if (!this.started) this._writeHeader();
    const o = this.out;
    const { palette, lut } = quantizeFrameRGBA(rgba, this.width, this.height);

    const pixelCount = this.width * this.height;
    const indices = this.indicesBuf;
    for (let i = 0; i < pixelCount; i++) {
      const off = i * 4;
      const key = ((rgba[off] >> 3) << 10) | ((rgba[off + 1] >> 3) << 5) | (rgba[off + 2] >> 3);
      indices[i] = lut[key];
    }

    // Graphic Control Extension
    const delayCs = Math.max(2, Math.round(delayMs / 10));
    o.writeByte(0x21);
    o.writeByte(0xf9);
    o.writeByte(4);    // Block size
    o.writeByte(0x04); // Disposal method 1 (do not dispose)
    o.writeShortLE(delayCs);
    o.writeByte(0);    // Transparent color index (unused)
    o.writeByte(0);    // Block terminator

    // Image Descriptor
    o.writeByte(0x2c);
    o.writeShortLE(0);
    o.writeShortLE(0);
    o.writeShortLE(this.width);
    o.writeShortLE(this.height);
    o.writeByte(0x87); // Local Color Table present (size = 2^(7+1) = 256)

    // Local Color Table (256 * 3 bytes)
    o.writeBytes(palette, 0, 768);

    // LZW Image Data
    writeLZW(o, indices, 8);
    this.frameCount++;
  }

  finish() {
    if (!this.started) this._writeHeader();
    this.out.writeByte(0x3b); // GIF Trailer
    return this.out.toUint8Array();
  }
}
