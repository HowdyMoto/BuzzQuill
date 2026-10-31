/**
 * Raster encoders for formats the browser's canvas.toBlob() doesn't support (BMP,
 * GIF, TIFF). PNG/JPEG/WebP still go through the native encoder; these fill the gap
 * so a frame can export to the classic raster formats too.
 *
 * All take an ImageData (RGBA, from a rasterized canvas). BMP and GIF are opaque
 * formats, so the caller composites onto a background first (alpha = 255); TIFF keeps
 * the alpha channel.
 */

/** Native-vs-custom split. png/jpeg/webp use canvas.toBlob; the rest are encoded here. */
export type RasterMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/bmp' | 'image/gif' | 'image/tiff';

/** Whether a format has no alpha channel — the caller must paint a background first. */
export function isOpaqueFormat(mime: RasterMime): boolean {
  return mime === 'image/jpeg' || mime === 'image/bmp' || mime === 'image/gif';
}

/** Turn a laid-out canvas into a Blob of the requested type, using the native encoder
 *  for png/jpeg/webp and our own for bmp/gif/tiff. */
export function canvasToRasterBlob(canvas: HTMLCanvasElement, mime: RasterMime, quality?: number): Promise<Blob> {
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp') {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas toBlob returned null'))), mime, quality);
    });
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('No 2D context'));
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const bytes = mime === 'image/bmp' ? encodeBMP(img)
    : mime === 'image/gif' ? encodeGIF(img)
    : encodeTIFF(img);
  return Promise.resolve(new Blob([bytes as unknown as BlobPart], { type: mime }));
}

// ---------------------------------------------------------------------------
// BMP — 32bpp BITMAPINFOHEADER, top-down. Caller composited onto a background, so
// pixels are opaque; the 4th byte carries alpha=255 for alpha-aware viewers.
// ---------------------------------------------------------------------------

export function encodeBMP(img: ImageData): Uint8Array {
  const { width: w, height: h, data } = img;
  const rowSize = w * 4;              // 32bpp rows are inherently 4-byte aligned
  const pixelBytes = rowSize * h;
  const offset = 14 + 40;            // file header + BITMAPINFOHEADER
  const out = new Uint8Array(offset + pixelBytes);
  const dv = new DataView(out.buffer);

  // BITMAPFILEHEADER (14)
  dv.setUint8(0, 0x42); dv.setUint8(1, 0x4d);           // "BM"
  dv.setUint32(2, out.length, true);                    // file size
  dv.setUint32(10, offset, true);                       // pixel-data offset
  // BITMAPINFOHEADER (40)
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, -h, true);                            // negative height → top-down rows
  dv.setUint16(26, 1, true);                            // planes
  dv.setUint16(28, 32, true);                           // bits per pixel
  dv.setUint32(30, 0, true);                            // BI_RGB
  dv.setUint32(34, pixelBytes, true);
  dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true); // ~72 DPI (pixels/metre)

  // Pixel data, BGRA.
  let o = offset;
  for (let i = 0; i < data.length; i += 4) {
    out[o++] = data[i + 2]; // B
    out[o++] = data[i + 1]; // G
    out[o++] = data[i];     // R
    out[o++] = data[i + 3]; // A (255 after compositing)
  }
  return out;
}

// ---------------------------------------------------------------------------
// TIFF — little-endian, uncompressed, 8-bit RGBA (keeps alpha). Baseline layout:
// [header 8][pixel data][IFD][out-of-line tag values].
// ---------------------------------------------------------------------------

export function encodeTIFF(img: ImageData): Uint8Array {
  const { width: w, height: h, data } = img;
  const pixels = w * h * 4;
  const NTAGS = 11;
  const ifdSize = 2 + NTAGS * 12 + 4; // count + entries + next-IFD offset
  const header = 8;
  const pixelOffset = header;
  const ifdOffset = header + pixels;
  const extraOffset = ifdOffset + ifdSize;   // BitsPerSample (4 shorts = 8 bytes)
  const total = extraOffset + 8;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  // Header
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49); // "II" little-endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOffset, true);

  // Pixel data (RGBA, row-major top-down — TIFF's default orientation).
  out.set(data, pixelOffset);

  // IFD
  let p = ifdOffset;
  dv.setUint16(p, NTAGS, true); p += 2;
  const tag = (id: number, type: number, count: number, value: number) => {
    dv.setUint16(p, id, true); dv.setUint16(p + 2, type, true);
    dv.setUint32(p + 4, count, true); dv.setUint32(p + 8, value, true); p += 12;
  };
  // type: 3 = SHORT, 4 = LONG. Tags MUST be in ascending id order.
  tag(256, 4, 1, w);                 // ImageWidth
  tag(257, 4, 1, h);                 // ImageLength
  tag(258, 3, 4, extraOffset);       // BitsPerSample → 8,8,8,8 (out of line)
  tag(259, 3, 1, 1);                 // Compression = none
  tag(262, 3, 1, 2);                 // PhotometricInterpretation = RGB
  tag(273, 4, 1, pixelOffset);       // StripOffsets
  tag(277, 3, 1, 4);                 // SamplesPerPixel
  tag(278, 4, 1, h);                 // RowsPerStrip (whole image = one strip)
  tag(279, 4, 1, pixels);            // StripByteCounts
  tag(284, 3, 1, 1);                 // PlanarConfiguration = chunky
  tag(338, 3, 1, 2);                 // ExtraSamples = unassociated alpha
  dv.setUint32(p, 0, true);          // next IFD = none (SampleFormat omitted → defaults to unsigned)

  // Out-of-line BitsPerSample: four 8s.
  dv.setUint16(extraOffset, 8, true); dv.setUint16(extraOffset + 2, 8, true);
  dv.setUint16(extraOffset + 4, 8, true); dv.setUint16(extraOffset + 6, 8, true);
  return out;
}

// ---------------------------------------------------------------------------
// GIF — median-cut to ≤256 colours + variable-width LZW (GIF89a). Caller composited
// onto a background (opaque), so no transparent index is needed.
// ---------------------------------------------------------------------------

export function encodeGIF(img: ImageData): Uint8Array {
  const { width: w, height: h, data } = img;
  const { palette, indices } = quantize(data);
  // Palette must be a power of two (2..256); pad with black.
  let bits = 1; while ((1 << bits) < palette.length) bits++;
  const palSize = 1 << bits;

  const out: number[] = [];
  const push = (...b: number[]) => { for (const x of b) out.push(x & 0xff); };
  const pushStr = (s: string) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };

  pushStr('GIF89a');
  push(w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff);
  push(0x80 | ((bits - 1) & 0x07)); // global color table, colour resolution, size
  push(0, 0);                       // background colour index, pixel aspect ratio
  for (let i = 0; i < palSize; i++) {
    const c = palette[i];
    push(c ? c[0] : 0, c ? c[1] : 0, c ? c[2] : 0);
  }
  // Image descriptor
  push(0x2c, 0, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff, 0);

  const minCode = Math.max(2, bits);
  push(minCode);
  for (const b of lzwEncode(indices, minCode)) push(b);
  push(0x3b); // trailer
  return Uint8Array.from(out);
}

type RGB = [number, number, number];

/** Median-cut colour quantization → a ≤256 palette plus a per-pixel index array. */
function quantize(data: Uint8ClampedArray): { palette: RGB[]; indices: Uint8Array } {
  const n = data.length / 4;
  // Exact path: if the image already uses ≤256 distinct colours, keep them verbatim.
  const seen = new Map<number, number>();
  let exact = true;
  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (!seen.has(key)) { if (seen.size >= 256) { exact = false; break; } seen.set(key, seen.size); }
  }
  if (exact) {
    const palette: RGB[] = [];
    seen.forEach((_, key) => { palette[seen.get(key)!] = [(key >> 16) & 255, (key >> 8) & 255, key & 255]; });
    const indices = new Uint8Array(n);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      indices[p] = seen.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])!;
    }
    return { palette: palette.length ? palette : [[0, 0, 0]], indices };
  }

  // Median cut over the unique colours (with counts).
  const counts = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const colors = [...counts.keys()];
  interface Box { cols: number[]; }
  let boxes: Box[] = [{ cols: colors }];
  const channel = (key: number, c: number) => (c === 0 ? (key >> 16) & 255 : c === 1 ? (key >> 8) & 255 : key & 255);
  while (boxes.length < 256) {
    // Split the box with the largest colour range along its longest axis.
    let bi = -1, bestRange = -1, bestAxis = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].cols.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const k of boxes[i].cols) { const v = channel(k, c); if (v < lo) lo = v; if (v > hi) hi = v; }
        const range = hi - lo;
        if (range > bestRange) { bestRange = range; bi = i; bestAxis = c; }
      }
    }
    if (bi < 0) break;
    const box = boxes[bi];
    box.cols.sort((a, b) => channel(a, bestAxis) - channel(b, bestAxis));
    const mid = box.cols.length >> 1;
    boxes.splice(bi, 1, { cols: box.cols.slice(0, mid) }, { cols: box.cols.slice(mid) });
  }

  // Palette = count-weighted average of each box; map every colour to its box index.
  const palette: RGB[] = [];
  const colorToIndex = new Map<number, number>();
  boxes.forEach((box, idx) => {
    let r = 0, g = 0, b = 0, tot = 0;
    for (const k of box.cols) {
      const ct = counts.get(k)!; tot += ct;
      r += ((k >> 16) & 255) * ct; g += ((k >> 8) & 255) * ct; b += (k & 255) * ct;
      colorToIndex.set(k, idx);
    }
    palette[idx] = tot ? [Math.round(r / tot), Math.round(g / tot), Math.round(b / tot)] : [0, 0, 0];
  });

  const indices = new Uint8Array(n);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    indices[p] = colorToIndex.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) ?? 0;
  }
  return { palette: palette.length ? palette : [[0, 0, 0]], indices };
}

/** GIF variable-width LZW, chunked into ≤255-byte sub-blocks (terminated by a 0). */
function lzwEncode(indices: Uint8Array, minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map<string, number>();
  const resetDict = () => {
    dict = new Map();
    for (let i = 0; i < clear; i++) dict.set(String(i), i);
  };
  resetDict();
  let next = eoi + 1;

  const out: number[] = [];
  let cur = 0, curBits = 0;
  const emit = (code: number) => {
    cur |= code << curBits; curBits += codeSize;
    while (curBits >= 8) { out.push(cur & 0xff); cur >>= 8; curBits -= 8; }
  };

  emit(clear);
  let prefix = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const combined = prefix + ',' + k;
    if (dict.has(combined)) { prefix = combined; continue; }
    emit(dict.get(prefix)!);
    dict.set(combined, next++);
    if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    else if (next > 4096) { emit(clear); resetDict(); next = eoi + 1; codeSize = minCodeSize + 1; }
    prefix = String(k);
  }
  emit(dict.get(prefix)!);
  emit(eoi);
  if (curBits > 0) out.push(cur & 0xff);

  // Pack into sub-blocks.
  const packed: number[] = [];
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    packed.push(chunk.length, ...chunk);
  }
  packed.push(0); // block terminator
  return packed;
}
