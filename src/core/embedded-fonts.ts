// ---------------------------------------------------------------------------
// Embedded-font registry — fonts extracted from an imported PDF (or otherwise
// embedded in the document) so text renders in its real typeface rather than a
// bundled substitute.
//
// Persistence mirrors TextStyleRegistry: the library lives in a hidden
//   <metadata class="bq-embedded-fonts" data-fonts="[…]">
// carrier inside #drawing-layer, so it round-trips the history/save snapshot for
// free (detectType returns null for <metadata>, so it is never a phantom layer).
// The FontFace objects themselves are NOT snapshotted — like effect <filter>s,
// they are a regenerated cache: ensureFontFaces() re-registers them with
// document.fonts after every rebuildShapesFromDOM so the glyphs survive undo,
// redo, and load. The model re-derives from the carrier via syncFromDOM().
//
// Data is stored base64 in the carrier attribute. That means the bytes ride in
// every history snapshot (the layer's innerHTML) — acceptable because embedded
// PDF fonts are subsetted (typically tens of KB) and deduplicated by content id.
// ---------------------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg';

/** A font carried inside the document. `id` doubles as the CSS font-family that
 *  text runs reference; it is content-derived (see fontId) so identical bytes
 *  dedupe to one entry across pages/runs. */
export interface EmbeddedFont {
  id: string;   // doc-scoped family id, e.g. "bqpdf-3af9c1e2"
  mime: string; // "font/opentype" etc. (informational; FontFace loads raw sfnt)
  b64: string;  // base64 of the font program bytes (sfnt: TTF/OTF)
}

export interface EmbeddedFontHost {
  getDrawingLayer: () => SVGGElement;
}

/** A stable, content-derived family id for a font program (djb2 over the bytes).
 *  Same bytes → same id, so a font used on many runs/pages is stored once. */
export function fontId(bytes: Uint8Array): string {
  let h = 5381;
  for (let i = 0; i < bytes.length; i++) h = (((h << 5) + h) ^ bytes[i]) >>> 0;
  // fold length in so different-length-same-prefix data can't collide as easily
  h = (((h << 5) + h) ^ (bytes.length & 0xffff)) >>> 0;
  return `bqpdf-${h.toString(16).padStart(8, '0')}`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000; // avoid arg-count limits on fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class EmbeddedFontRegistry {
  private host: EmbeddedFontHost;
  private fonts: EmbeddedFont[] = [];
  /** ids already handed to document.fonts, so ensureFontFaces is idempotent. */
  private registered = new Set<string>();

  constructor(host: EmbeddedFontHost) { this.host = host; }

  /** Re-read the model from the carrier (the source of truth). Called after every
   *  rebuildShapesFromDOM so undo/redo/load re-sync the library from the markup. */
  syncFromDOM(): void {
    this.fonts = [];
    const c = this.carrier();
    if (c) {
      try {
        const parsed = JSON.parse(c.getAttribute('data-fonts') || '[]');
        if (Array.isArray(parsed)) this.fonts = parsed.filter((f): f is EmbeddedFont => !!f && typeof f.id === 'string' && typeof f.b64 === 'string');
      } catch { /* corrupt carrier — start empty rather than throw */ }
    }
  }

  private carrier(): Element | null {
    return this.host.getDrawingLayer().querySelector(':scope > metadata.bq-embedded-fonts');
  }

  private ensureCarrier(): Element {
    let c = this.carrier();
    if (!c) {
      c = document.createElementNS(NS, 'metadata');
      c.setAttribute('class', 'bq-embedded-fonts');
      this.host.getDrawingLayer().prepend(c); // first child: stable, out of the z-order
    }
    return c;
  }

  private flush(): void {
    if (this.fonts.length === 0) { this.carrier()?.remove(); return; }
    this.ensureCarrier().setAttribute('data-fonts', JSON.stringify(this.fonts));
  }

  list(): EmbeddedFont[] { return this.fonts; }
  has(id: string): boolean { return this.fonts.some((f) => f.id === id); }

  /** Add a font unless an entry with the same id already exists (content dedupe).
   *  Persists into the carrier and registers the FontFace. Does NOT record history
   *  — the caller batches it into the import's single undo step. */
  add(font: EmbeddedFont): void {
    if (!this.has(font.id)) { this.fonts.push(font); this.flush(); }
    this.ensureFontFaces();
  }

  /** Register any not-yet-registered fonts with document.fonts so text renders in
   *  them. Idempotent; runs after every rebuild/restore because FontFaces (like
   *  effect filters) are a regenerated cache, not part of the snapshot. */
  ensureFontFaces(): void {
    if (typeof document === 'undefined' || !(document as any).fonts) return;
    for (const f of this.fonts) {
      if (this.registered.has(f.id)) continue;
      this.registered.add(f.id); // mark first so a throw doesn't retry-loop each rebuild
      try {
        const bytes = base64ToBytes(f.b64);
        const face = new FontFace(f.id, bytes.buffer as ArrayBuffer);
        (document as any).fonts.add(face);
        face.load().catch(() => { /* undecodable font — text falls back to serif */ });
      } catch { /* invalid data — leave unregistered; text falls back */ }
    }
  }
}
