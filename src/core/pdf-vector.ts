/**
 * PDF page → editable SVG objects (the "Import as vectors" path).
 *
 * Walks PDF.js's low-level operator list (`page.getOperatorList()`) with a small
 * graphics-state machine and emits SVG `<path>`/`<image>` markup; text comes from
 * the higher-level `page.getTextContent()`. This is the reliable 80% — paths,
 * solid fills/strokes (incl. gray/CMYK), per-object transforms, raster images and
 * horizontal text. The long tail (shadings/gradients, tiling patterns, soft masks,
 * blend modes, real clip regions) is deliberately NOT reproduced: a page that
 * relies on it is reported `confident:false` so the importer can rasterize it.
 *
 * Coordinates: operator coords are PDF user space (y-up). We start the CTM at
 * `viewport.transform` (which flips to SVG's y-down device space) and compose
 * `OPS.transform`/form-xobject matrices on top, emitting each element with a
 * `transform="matrix(CTM)"` so its `d`/geometry stays in local coords.
 */

import { fontId, bytesToBase64, type EmbeddedFont } from './embedded-fonts';
import { escapeHtml } from '../ui/dom';

// --- PDF.js operator ids we care about (from pdfjs-dist build/pdf.mjs `OPS`) ---
const OPS = {
  setLineWidth: 2, setLineCap: 3, setLineJoin: 4, setMiterLimit: 5, setDash: 6,
  save: 10, restore: 11, transform: 12,
  stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24,
  eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28,
  clip: 29, eoClip: 30,
  setStrokeColor: 52, setFillColor: 54, setFillColorN: 55,
  setStrokeGray: 56, setFillGray: 57, setStrokeRGBColor: 58, setFillRGBColor: 59,
  setStrokeCMYKColor: 60, setFillCMYKColor: 61,
  shadingFill: 62,
  paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
  paintImageMaskXObject: 83, paintImageXObject: 85,
  paintInlineImageXObject: 86, paintSolidColorImageMask: 90,
  constructPath: 91, setStrokeTransparent: 92, setFillTransparent: 93,
} as const;

// Sub-ops inside a constructPath Float32Array (from `DrawOPS`).
const D_MOVE = 0, D_LINE = 1, D_CURVE = 2, D_QUAD = 3, D_CLOSE = 4;

type Mat = [number, number, number, number, number, number];

/** m1 ∘ m2 — the matrix that applies m2 to a point, then m1 (PDF.js `Util.transform`). */
function mul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const r3 = (n: number): string => {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? '0' : String(v);
};
const matAttr = (m: Mat): string => `matrix(${m.map(r3).join(' ')})`;

function grayHex(g: number): string {
  const v = Math.max(0, Math.min(255, Math.round(g * 255)));
  const h = v.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}
function cmykHex(c: number, m: number, y: number, k: number): string {
  const to = (x: number) => Math.round(255 * (1 - Math.min(1, x * (1 - k) + k)));
  const h = (x: number) => to(x).toString(16).padStart(2, '0');
  return `#${h(c)}${h(m)}${h(y)}`;
}

/** Turn a constructPath Float32Array (flat DrawOPS) into an SVG path `d`. */
function drawOpsToPath(data: ArrayLike<number>): string {
  let d = '';
  for (let i = 0; i < data.length;) {
    switch (data[i++]) {
      case D_MOVE: d += `M${r3(data[i++])} ${r3(data[i++])}`; break;
      case D_LINE: d += `L${r3(data[i++])} ${r3(data[i++])}`; break;
      case D_CURVE: d += `C${r3(data[i++])} ${r3(data[i++])} ${r3(data[i++])} ${r3(data[i++])} ${r3(data[i++])} ${r3(data[i++])}`; break;
      case D_QUAD: d += `Q${r3(data[i++])} ${r3(data[i++])} ${r3(data[i++])} ${r3(data[i++])}`; break;
      case D_CLOSE: d += 'Z'; break;
      default: return d; // unknown sub-op — stop rather than misread
    }
  }
  return d;
}

interface GState {
  ctm: Mat;
  fill: string;
  stroke: string;
  lineWidth: number;
  cap: string;
  join: string;
  dash: string;
  fillAlpha: number;
  strokeAlpha: number;
}
const cloneState = (s: GState): GState => ({ ...s });

export interface VectorPage {
  /** SVG element strings, in paint order, in device (SVG) space. */
  elements: string[];
  /** false → page uses features we don't vectorize; caller should rasterize it. */
  confident: boolean;
  /** Human-readable reasons the page was flagged (shadings, patterns, …). */
  reasons: string[];
  /** Real embedded fonts (license-permitting) whose ids the text runs reference,
   *  so the caller can register them in the document. Empty when text is 'live'
   *  substitution only (no font data, or embedding disallowed). */
  fonts: EmbeddedFont[];
}

/** Whether a font's OS/2 fsType permits carrying it into a derived document. We
 *  embed only Installable (0) or Editable (bit 3); Restricted (bit 1) and
 *  Preview&Print (bit 2) fall back to substitution — the defensible line for an
 *  editor (see the licensing note where this is called). No OS/2 table → no embed. */
function embeddingAllowed(data: Uint8Array): boolean {
  try {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const numTables = dv.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      if (String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]) === 'OS/2') {
        const fsType = dv.getUint16(dv.getUint32(o + 8) + 8);
        return fsType === 0 || (fsType & 0x0008) !== 0;
      }
    }
  } catch { /* unparseable sfnt — do not embed */ }
  return false;
}

export interface VectorExtractOptions {
  /** Include <text> runs (live text). When false, the caller outlines them later. */
  includeText: boolean;
}

/**
 * Extract one page as SVG element strings. `pdfjs` is the loaded module (for OPS
 * parity we hard-code ids above; the module is only used for image decoding).
 */
export async function extractPageVectors(
  page: any,
  opts: VectorExtractOptions,
): Promise<VectorPage> {
  const viewport = page.getViewport({ scale: 1 });
  const base: Mat = viewport.transform as Mat;
  const opList = await page.getOperatorList();

  const elements: string[] = [];
  const reasons = new Set<string>();
  let confident = true;

  let st: GState = {
    ctm: base, fill: '#000000', stroke: '#000000', lineWidth: 1,
    cap: 'butt', join: 'miter', dash: '', fillAlpha: 1, strokeAlpha: 1,
  };
  const stack: GState[] = [];

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push(cloneState(st)); break;
      case OPS.restore: if (stack.length) st = stack.pop()!; break;
      case OPS.transform: st.ctm = mul(st.ctm, a as Mat); break;

      case OPS.setLineWidth: st.lineWidth = a[0]; break;
      case OPS.setLineCap: st.cap = ['butt', 'round', 'square'][a[0]] || 'butt'; break;
      case OPS.setLineJoin: st.join = ['miter', 'round', 'bevel'][a[0]] || 'miter'; break;
      case OPS.setDash: st.dash = Array.isArray(a[0]) && a[0].length ? a[0].join(',') : ''; break;

      case OPS.setFillRGBColor: st.fill = typeof a[0] === 'string' ? a[0] : '#000000'; break;
      case OPS.setStrokeRGBColor: st.stroke = typeof a[0] === 'string' ? a[0] : '#000000'; break;
      case OPS.setFillGray: st.fill = grayHex(a[0]); break;
      case OPS.setStrokeGray: st.stroke = grayHex(a[0]); break;
      case OPS.setFillCMYKColor: st.fill = cmykHex(a[0], a[1], a[2], a[3]); break;
      case OPS.setStrokeCMYKColor: st.stroke = cmykHex(a[0], a[1], a[2], a[3]); break;
      case OPS.setFillColor: if (typeof a[0] === 'string') st.fill = a[0]; break;
      case OPS.setStrokeColor: if (typeof a[0] === 'string') st.stroke = a[0]; break;
      case OPS.setFillColorN:
        // A pattern/shading fill (tiling or gradient) — we can't vectorize it.
        if (typeof a[0] === 'string') st.fill = a[0];
        else { reasons.add('pattern fill'); confident = false; }
        break;

      case OPS.constructPath: emitPath(a); break;

      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
        await emitImage(a[0]); break;
      case OPS.paintImageMaskXObject:
      case OPS.paintSolidColorImageMask:
        reasons.add('image mask'); confident = false; break;

      case OPS.shadingFill: reasons.add('gradient/shading'); confident = false; break;

      // Form XObjects are expanded inline by getOperatorList; the begin op carries
      // an optional matrix. Treat begin/end as a save/transform … restore bracket.
      case OPS.paintFormXObjectBegin:
        stack.push(cloneState(st));
        if (a[0]) st.ctm = mul(st.ctm, a[0] as Mat);
        break;
      case OPS.paintFormXObjectEnd:
        if (stack.length) st = stack.pop()!; break;

      case OPS.clip: case OPS.eoClip:
        reasons.add('clip region'); break; // skipped (content may overflow its clip)
      default: break;
    }
  }

  // Resolve a text item's weight/slant and — when possible — its REAL embedded
  // font. pdf.js exposes only fontFamily via tc.styles; the weight & slant live in
  // the embedded font's real NAME (e.g. "AAAAAA+TimesNewRomanPS-BoldItalicMT"), and
  // the font PROGRAM lives on `f.data` when the doc was opened with
  // fontExtraProperties. commonObjs is populated by the getOperatorList() pass
  // above; get() throws if a font never resolved.
  //
  // Licensing: we carry the embedded font into the (derived) document only when its
  // OS/2 fsType permits embedding — the same permission bit Acrobat/Illustrator
  // honour when you edit a PDF. Restricted fonts fall back to substitution.
  const embedded = new Map<string, EmbeddedFont>();
  const fontCache = new Map<string, { bold: boolean; italic: boolean; family: string | null }>();
  const resolveFont = (fontName: string): { bold: boolean; italic: boolean; family: string | null } => {
    const cached = fontCache.get(fontName);
    if (cached) return cached;
    let bold = false, italic = false, family: string | null = null;
    try {
      const f = page.commonObjs.get(fontName);
      if (f) {
        bold = !!f.bold; italic = !!f.italic;
        const name = String(f.name || '').replace(/^[A-Z]{6}\+/, ''); // strip subset prefix
        if (/bold|black|heavy|semibold|demibold/i.test(name)) bold = true;
        if (/italic|oblique/i.test(name)) italic = true;
        const data: Uint8Array | undefined = f.data instanceof Uint8Array ? f.data : undefined;
        if (data && data.length && embeddingAllowed(data)) {
          const id = fontId(data); // content-hashed → identical fonts dedupe to one
          if (!embedded.has(id)) embedded.set(id, { id, mime: f.mimetype || 'font/opentype', b64: bytesToBase64(data) });
          family = id; // the run renders in the real font (registered by the caller)
        }
      }
    } catch { /* font not resolved — substitute */ }
    // When the real font is embedded, its glyphs already ARE bold/italic and each
    // style variant is a distinct family id — so don't also emit font-weight/style,
    // or the browser would faux-bold/-slant an already-styled face. Emphasis is only
    // needed to steer the SUBSTITUTE (variable PT Serif) toward the right weight.
    const r = family ? { bold: false, italic: false, family } : { bold, italic, family };
    fontCache.set(fontName, r);
    return r;
  };

  // --- Text via the high-level API (cleaner than showText glyph arrays) ---
  if (opts.includeText) {
    try {
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const t = it.transform as Mat;      // text space → device via viewport
        const m = mul(base, t);
        const { bold, italic, family: embFamily } = resolveFont(it.fontName);
        // Prefer the real embedded font id; else the generic family (the caller maps
        // that to a bundled substitute). Either way textLength pins the run width.
        const family = embFamily || tc.styles?.[it.fontName]?.fontFamily || 'sans-serif';
        // it.width is the run's advance in device units (viewport scale 1); pass it
        // so the run can be pinned to that exact width — a substituted font's metrics
        // differ from the embedded one and would otherwise overflow/overlap.
        elements.push(textEl(m, it.str, family, it.width || 0, bold, italic));
      }
    } catch { /* text layer optional */ }
  }

  return { elements, confident, reasons: [...reasons], fonts: [...embedded.values()] };

  // ---- helpers closing over `st`/`elements` ----
  function emitPath(args: any[]): void {
    const paintOp: number = args[0];
    const data = Array.isArray(args[1]) ? args[1][0] : args[1];
    if (!data || data.length === undefined) return;
    const d = drawOpsToPath(data as ArrayLike<number>);
    if (!d) return;

    const doFill = paintOp === OPS.fill || paintOp === OPS.eoFill ||
      paintOp === OPS.fillStroke || paintOp === OPS.eoFillStroke ||
      paintOp === OPS.closeFillStroke || paintOp === OPS.closeEOFillStroke;
    const doStroke = paintOp === OPS.stroke || paintOp === OPS.closeStroke ||
      paintOp === OPS.fillStroke || paintOp === OPS.eoFillStroke ||
      paintOp === OPS.closeFillStroke || paintOp === OPS.closeEOFillStroke;
    if (paintOp === OPS.clip || paintOp === OPS.eoClip || paintOp === OPS.endPath) {
      if (paintOp !== OPS.endPath) reasons.add('clip region');
      return; // clip/no-paint path
    }
    if (!doFill && !doStroke) return;
    const evenOdd = paintOp === OPS.eoFill || paintOp === OPS.eoFillStroke || paintOp === OPS.closeEOFillStroke;

    const attrs: string[] = [`d="${d}"`, `transform="${matAttr(st.ctm)}"`];
    attrs.push(`fill="${doFill ? st.fill : 'none'}"`);
    if (doFill && evenOdd) attrs.push('fill-rule="evenodd"');
    if (doFill && st.fillAlpha < 1) attrs.push(`fill-opacity="${r3(st.fillAlpha)}"`);
    if (doStroke) {
      attrs.push(`stroke="${st.stroke}"`);
      attrs.push(`stroke-width="${r3(st.lineWidth)}"`);
      if (st.cap !== 'butt') attrs.push(`stroke-linecap="${st.cap}"`);
      if (st.join !== 'miter') attrs.push(`stroke-linejoin="${st.join}"`);
      if (st.dash) attrs.push(`stroke-dasharray="${st.dash}"`);
      if (st.strokeAlpha < 1) attrs.push(`stroke-opacity="${r3(st.strokeAlpha)}"`);
    }
    elements.push(`<path ${attrs.join(' ')}/>`);
  }

  async function emitImage(id: string): Promise<void> {
    let img: any;
    try {
      img = id?.startsWith?.('g_') ? page.commonObjs.get(id) : page.objs.get(id);
    } catch { img = null; }
    if (!img) { reasons.add('image (unresolved)'); confident = false; return; }
    const url = imageToDataUrl(img);
    if (!url) { reasons.add('image (undecodable)'); confident = false; return; }
    // The image fills the unit square; PDF image row 0 is the TOP, so flip Y within it.
    const m = mul(st.ctm, [1, 0, 0, -1, 0, 1] as Mat);
    elements.push(`<image href="${url}" width="1" height="1" preserveAspectRatio="none" transform="${matAttr(m)}"/>`);
  }
}

/** Render a PDF.js image object (ImageBitmap or raw RGBA/RGB) to a PNG data URL. */
function imageToDataUrl(img: any): string | null {
  try {
    const w = img.width, h = img.height;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (img.bitmap && typeof ImageBitmap !== 'undefined' && img.bitmap instanceof ImageBitmap) {
      ctx.drawImage(img.bitmap, 0, 0);
    } else if (img.data) {
      const data: Uint8ClampedArray | Uint8Array = img.data;
      const rgba = new Uint8ClampedArray(w * h * 4);
      if (data.length === w * h * 4) {
        rgba.set(data);
      } else if (data.length === w * h * 3) {
        for (let s = 0, d = 0; s < data.length; s += 3, d += 4) {
          rgba[d] = data[s]; rgba[d + 1] = data[s + 1]; rgba[d + 2] = data[s + 2]; rgba[d + 3] = 255;
        }
      } else if (data.length === w * h) {
        for (let s = 0, d = 0; s < data.length; s++, d += 4) {
          rgba[d] = rgba[d + 1] = rgba[d + 2] = data[s]; rgba[d + 3] = 255;
        }
      } else return null;
      ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    } else return null;
    return canvas.toDataURL('image/png');
  } catch { return null; }
}

/** Emit a <text> run. Simple x/y for upright text; full matrix when rotated/skewed.
 *  `width` is the run's PDF advance (device units): for upright text we pin the run
 *  to it via textLength + lengthAdjust="spacingAndGlyphs", so the substituted font
 *  is stretched/condensed to sit exactly where the embedded font did — the same
 *  technique pdf.js's selectable text layer uses to overlay Chrome's rendering.
 *  This is what keeps justified lines inside the margins instead of overrunning. */
function textEl(m: Mat, str: string, family: string, width: number, bold: boolean, italic: boolean): string {
  const rotated = Math.abs(m[1]) > 1e-3 || Math.abs(m[2]) > 1e-3;
  // Single-quote families with non-letter chars (CSS syntax), then escapeHtml() for the
  // double-quoted attribute so a hostile font name can't break out of it.
  const fam = escapeHtml(/[^a-z\-]/i.test(family) ? `'${family.replace(/'/g, '')}'` : family);
  const emph = (bold ? ' font-weight="bold"' : '') + (italic ? ' font-style="italic"' : '');
  if (!rotated) {
    const size = Math.abs(m[3]) || Math.abs(m[0]) || 1;
    const fit = width > 0 ? ` textLength="${r3(width)}" lengthAdjust="spacingAndGlyphs"` : '';
    return `<text x="${r3(m[4])}" y="${r3(m[5])}" font-size="${r3(size)}" font-family="${fam}"${emph} fill="#000000" xml:space="preserve"${fit}>${escapeHtml(str)}</text>`;
  }
  // Rotated: unit font-size, glyph orientation via the (y-flipped) text matrix.
  const tm: Mat = [m[0], m[1], m[2], m[3], m[4], m[5]];
  return `<text transform="${matAttr(tm)}" font-size="1" font-family="${fam}"${emph} fill="#000000" xml:space="preserve">${escapeHtml(str)}</text>`;
}
