/**
 * Asset Library — the generic, document-scoped model behind the Library panel.
 *
 * The Library lets a user save reusable assets — text styles, colour palettes,
 * components/shapes, effect styles, paint styles — inside the document. This
 * module covers only the asset types that have no home of their
 * own: palettes, effect styles and paint styles. (Text styles keep
 * TextStyleRegistry; components keep SymbolRegistry — the Library panel unions
 * all of them through per-type adapters in ui/library/.)
 *
 * STORAGE — mirrors TextStyleRegistry exactly (see core/text-styles.ts):
 *  the library of definitions lives in a hidden `<metadata class="bq-library">`
 *  carrier inside #drawing-layer whose `data-assets` attribute holds the JSON.
 *  That single home survives BOTH undo (it's in the #drawing-layer.innerHTML
 *  snapshot) AND save/load (getDrawingLayerSVG includes it; the sanitizer keeps
 *  <metadata>). `detectType` returns null for <metadata>, so it is never a
 *  phantom layer. The model re-derives from the carrier after every
 *  rebuildShapesFromDOM (see AppState) — like effects/markers re-ensure.
 *
 * History recording, propagation to instances, and onChange are orchestrated by
 * AppState; this class is pure model + persistence, like TextStyleRegistry.
 */

const NS = 'http://www.w3.org/2000/svg';

/** 6 random base36 chars — the per-asset suffix that keeps ids unique across
 *  documents (so a pasted object's style link can't collide with a local style). */
function randomToken(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
}

/** Every asset type the Library can hold. Text styles + components are backed by
 *  their own registries; the rest live in this generic registry. */
export type AssetType = 'text-style' | 'palette' | 'component' | 'effect-style' | 'paint-style' | 'pattern';

/** Colour set — a named palette's payload. */
export interface PalettePayload { colors: string[]; }

/** Blur/drop-shadow preset — an effect style's payload (mirrors ObjectShadow + blur). */
export interface EffectStylePayload {
  blur?: number;
  shadow?: { dx: number; dy: number; blur: number; color: string; opacity: number };
}

/** A fill/stroke paint — a paint style's payload. A solid colour, or a gradient/
 *  pattern def id plus the def markup so it round-trips into a fresh document. */
export interface PaintStylePayload {
  kind: 'solid' | 'gradient' | 'pattern';
  /** For 'solid': the hex colour. For gradient/pattern: the `url(#id)` reference. */
  value: string;
  /** For gradient/pattern: the def element's outerHTML, replanted into <defs> on apply. */
  defMarkup?: string;
  /** For gradient/pattern: the id of THIS document's canonical def for the style —
   *  every object using the style points at it, so editing it updates them all. Not
   *  meaningful in another document (it's re-adopted there), just bookkeeping. It
   *  can't live as an attribute on the def: updateGradient/updatePattern recreate
   *  that element from the model, which would wipe any marker we stamped on it. */
  defId?: string;
}

/**
 * The uniform envelope the Library panel speaks in. `payload` is type-specific
 * (one of the *Payload shapes above, or TextStyleProps for a text style / a
 * component descriptor). `origin`/`rev` are legacy provenance left by the retired
 * account library on copies instantiated from it — tolerated on read, never written.
 */
export interface LibraryAsset {
  id: string;        // 'asset-N' (this registry) or the native id (ts-N / symbol-N)
  type: AssetType;
  name: string;
  payload: unknown;
  origin?: string;   // legacy: account uuid this copy was instantiated from
  rev?: number;      // legacy: account rev this copy was pulled at
}

/** The asset types stored in THIS generic registry (not text-style/component). */
const GENERIC_TYPES: ReadonlySet<AssetType> = new Set<AssetType>(['palette', 'effect-style', 'paint-style', 'pattern']);

export interface LibraryHost {
  getDrawingLayer: () => SVGGElement;
}

export class LibraryRegistry {
  private host: LibraryHost;
  private assets: LibraryAsset[] = [];
  private counter = 0;

  constructor(host: LibraryHost) { this.host = host; }

  /** Re-read the model from the carrier (the source of truth). Called after every
   *  rebuildShapesFromDOM so undo/redo/load re-sync the library from the markup. */
  syncFromDOM(): void {
    this.assets = [];
    const carrier = this.carrier();
    if (carrier) {
      try {
        const parsed = JSON.parse(carrier.getAttribute('data-assets') || '[]');
        if (Array.isArray(parsed)) this.assets = parsed as LibraryAsset[];
      } catch { /* corrupt carrier — start empty rather than throw */ }
    }
    // The sequence is PERSISTED on the carrier, never re-derived from the surviving
    // assets: deriving it meant a deleted asset's id got handed back out, and any
    // shape still carrying that dead link silently joined the next style created
    // (objects keep their link on delete only in old documents — see detach below).
    // Legacy carriers have no data-seq, so fall back to the max id present.
    const stored = parseInt(carrier?.getAttribute('data-seq') ?? '', 10);
    this.counter = Number.isFinite(stored) && stored > 0 ? stored : 0;
    for (const a of this.assets) {
      const m = /^asset-(\d+)/.exec(a.id); // matches legacy 'asset-N' and 'asset-N-token'
      if (m) this.counter = Math.max(this.counter, parseInt(m[1], 10));
    }
  }

  private carrier(): Element | null {
    return this.host.getDrawingLayer().querySelector(':scope > metadata.bq-library');
  }

  private ensureCarrier(): Element {
    let c = this.carrier();
    if (!c) {
      c = document.createElementNS(NS, 'metadata');
      c.setAttribute('class', 'bq-library');
      this.host.getDrawingLayer().prepend(c); // first child: stable, out of the z-order
    }
    return c;
  }

  /** Persist the model into the carrier. Removes the carrier entirely when empty
   *  so untouched documents stay pristine. Call before AppState.saveHistory. */
  private flush(): void {
    // Keep the carrier once anything has ever been created, so data-seq survives —
    // dropping it would restart the sequence and recycle ids. A document that never
    // had an asset still stays pristine (counter 0 ⇒ no carrier).
    if (this.assets.length === 0 && this.counter === 0) { this.carrier()?.remove(); return; }
    const c = this.ensureCarrier();
    c.setAttribute('data-assets', JSON.stringify(this.assets));
    c.setAttribute('data-seq', String(this.counter));
  }

  /** All generic assets, or just those of one type. */
  list(type?: AssetType): LibraryAsset[] {
    return type ? this.assets.filter((a) => a.type === type) : this.assets.slice();
  }

  get(id: string): LibraryAsset | undefined { return this.assets.find((a) => a.id === id); }

  create(type: AssetType, name: string, payload: unknown, extra?: Pick<LibraryAsset, 'origin' | 'rev'>): LibraryAsset {
    if (!GENERIC_TYPES.has(type)) {
      throw new Error(`LibraryRegistry does not store '${type}' — it has its own registry.`);
    }
    // A random token makes the id unique across DOCUMENTS too, so an object pasted
    // from another file can never land on a live style id here and be adopted by it.
    const asset: LibraryAsset = {
      id: `asset-${++this.counter}-${randomToken()}`, type, name, payload, ...(extra ?? {}),
    };
    this.assets.push(asset);
    this.flush();
    return asset;
  }

  rename(id: string, name: string): void {
    const a = this.get(id);
    if (a) { a.name = name; this.flush(); }
  }

  /** Redefine an asset's payload (and optionally its cloud rev after an update). */
  update(id: string, payload: unknown, rev?: number): void {
    const a = this.get(id);
    if (a) { a.payload = payload; if (rev !== undefined) a.rev = rev; this.flush(); }
  }

  /** Stamp cloud provenance (origin uuid + rev) WITHOUT touching the payload —
   *  used after a document asset is promoted to the account library, so the ⤓
   *  update badge can later tell when the cloud definition has moved on. */
  retag(id: string, extra: Pick<LibraryAsset, 'origin' | 'rev'>): void {
    const a = this.get(id);
    if (a) { a.origin = extra.origin; a.rev = extra.rev; this.flush(); }
  }

  remove(id: string): void {
    const i = this.assets.findIndex((a) => a.id === id);
    if (i >= 0) { this.assets.splice(i, 1); this.flush(); }
  }
}
