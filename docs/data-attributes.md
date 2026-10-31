# `data-*` attribute registry

BuzzQuill encodes feature state as `data-*` attributes on SVG elements. **This is
the persistence layer**, not an implementation detail: undo/redo and save/load are
an `innerHTML` snapshot of `#drawing-layer` (see `CLAUDE.md`), and `<defs>` is NOT
in that snapshot — so anything in defs (filters, markers, clips, gradients) is a
*regenerated cache* whose parameters must live as `data-*` on the element to
survive the round-trip. When you add state to an element, prefer a `data-*`
attribute so it round-trips for free.

This is the map of who owns what. Two big buckets:

- **Document attributes** live on elements inside `#drawing-layer`. They round-trip
  through the history/save snapshot and are re-read by `rebuildShapesFromDOM`
  (`detectType`/`readStyle`) or a subsystem's `syncFromDOM`.
- **Chrome attributes** live on editor UI (toolbar, menus, overlays) *outside*
  `#drawing-layer`. They are wired once at boot and never exported or snapshotted.

> Keep this current when you add or rename a `data-*` attribute. To re-derive the
> live list: `grep -rhoE "data-[a-z][a-z0-9-]+" src/ index.html | sort | uniq -c | sort -rn`
> (`index.html` matters — a lot of the chrome attributes are only in the markup).

## Document attributes (round-trip via the snapshot)

### Shape identity & layer metadata — `core/state.ts`, `ui/layers.ts`
| Attribute | Meaning |
|---|---|
| `id="shape-N"` | The selectable-layer id (not `data-*`, but the anchor everything keys off). |
| `data-name` | User-set layer name (else derived from tag). |
| `data-name-auto` | The name is auto-derived (a text layer named from its content) and refreshes on edit; a manual rename removes it (`tools/text.ts`, `renameShape`). |
| `data-locked` | Layer is locked: a canvas press passes through it (and through everything inside a locked group/frame) to what's beneath, and it gets no handles; the Layers panel can still select it. The rule is `isLockedEl` in `core/locks.ts`. |
| `data-collapsed` | Group row is collapsed in the Layers panel. |

### Frames — `core/state.ts` (frames model), `ui/frame-panel.ts`, `ui/frame-guides.ts`
`<g data-frame>` is a Figma container; its cache is `AppState.artboards`.
| Attribute | Meaning |
|---|---|
| `data-frame` | Marks the `<g>` as a frame (top-level only). |
| `data-radius` | On a plain `<rect>`: the AUTHORED corner radius, kept when the box is too small to draw it. `rx`/`ry` carry the clamped value actually rendered (both set to `min(w,h)/2`, or SVG clamps them independently and the corners go elliptical); growing the box restores the authored radius. Absent when the full radius fits. |
| `data-layer` | Marks an imported editor LAYER wrapper (Inkscape `groupmode="layer"`). Like a frame it is a CONTAINER: transparent to click-selection, so clicking its contents selects the contents. Set on import; the group is never restructured (folding its transform onto children double-applies it to any `<use>` targeting a sibling). |
| `data-frame-w` / `data-frame-h` | Frame bounds (NOT a scale transform — frames resize their own box). |
| `data-frame-rulers` | Per-frame rulers on/off (editor chrome config, but stored here so it round-trips). |
| `data-grid`, `data-grid-mode`, `data-grid-size`, `data-grid-cols`, `data-grid-rows`, `data-grid-subdiv`, `data-grid-color`, `data-grid-snap`, `data-grid-hidden` | Per-frame grid config. `data-grid-mode="divisions"` divides the frame into exactly cols × rows parts (spacing re-derived on resize); absent = fixed pixel spacing (`data-grid-size`). |
| `data-export-targets` | The frame's export targets — JSON array of `{format,name,scale}` plus optional `width`/`height`, per-format options (`textMode`, `bake`, `background`, `quality`) and `bounds` (`'paths'` fits the canvas to the visible path geometry; absent means the frame). |
| `data-export-format`, `data-export-scale` | The legacy single-target settings. Read only to migrate an old document; both are removed the first time `setExportTargets` writes `data-export-targets`. |

### Repeat grid — `core/repeat.ts`, `ui/repeat-panel.ts`
`<g data-repeat>` works like a group: every ordinary child is part of the repeated cell.
| Attribute | Meaning |
|---|---|
| `data-repeat` | Marks the wrapper. Ordinary children = the cell (modeled, fully editable). |
| `data-repeat-cols` / `data-repeat-rows` / `data-repeat-gap-x` / `data-repeat-gap-y` | Grid config. |
| `data-repeat-clone` | A generated `<g>` instance holding id-less copies of the cell (regenerated cache, never modeled). |
| `data-repeat-src` | Legacy single-source marker (pre multi-child cells) — ignored and stripped opportunistically. |

### Rect (parametric per-corner radii) — `core/rect-shape.ts`
| Attribute | Meaning |
|---|---|
| `data-rect` | Marks a `<path>` that is really a parametric rounded-rect. |
| `data-rect-radii` | The four corner radii. |
| `data-rect-x/y/w/h` | The rect box the `d` was generated from. |

### Parametric library shapes — `core/parametric.ts`, `core/shape-library.ts`, `ui/shape-picker.ts`
Pie/arc/polygon/ring/star/plus stay parametric forever: the `d`/`points` are regenerated
from these params plus the ellipse (or bbox) **recovered from the CURRENT geometry** —
there is no stored box, so move/resize/undo just work and a resize regenerates the curve
instead of scaling it into béziers. On-canvas handles live in `ui/parametric-handles.ts`.
| Attribute | Meaning |
|---|---|
| `data-shape` | The kind: `pie` \| `arc` \| `polygon` \| `ring` \| `star` \| `plus`. Its presence is what makes an ordinary `<path>`/`<polygon>` parametric. |
| `data-shape-a0` / `data-shape-a1` | Start/end angle in degrees (pie + arc; 0 = east, 90 = down). |
| `data-shape-sides` | Vertex count for `polygon` (clamped 3–60) — and **point count for `star`** (3–30); the two shapes share the attribute. |
| `data-shape-inner` | Inner ÷ outer radius ratio: the ring's hole (0.05–0.9), the star's spike depth (0.1–0.95). Shared, same as above. |
| `data-shape-arm` | Plus/cross arm thickness as a fraction of the shorter box side (0.1–0.85). |

### Boolean / Pathfinder (live compound) — `core/boolean.ts`, `core/pathfinder.ts`
| Attribute | Meaning |
|---|---|
| `data-boolean` | Wrapper `<g>` for a live boolean; value = op (unite/subtract/…). (`data-bool` is *chrome* on the pathfinder buttons — see below — not this wrapper.) |
| `data-bool-operand` | An editable operand child. |
| `data-bool-result` | The cached computed-geometry `<path>` (regenerated). |
| `data-bool-editing` | Transient: operands are being edited in isolation. |
| `data-boolean-preview` | Transient hover preview of the op's result, injected into `#drawing-layer` by `ui/pathfinder.ts`. `detectType` returns null for it so it's never a model shape, and it's swept before the next snapshot. |
| `data-boolean-dim` | Marks an operand faded behind that preview; the value stores its original `opacity` so it restores exactly. |

### Appearance stack (multiple fills/strokes) — `core/appearance.ts`
Only `data-appearance` + `data-ap-src` are authored state; everything else marks a
render child that `regenerate()` rebuilds from them.
| Attribute | Meaning |
|---|---|
| `data-appearance` | Wrapper `<g>`; the fill/stroke stack (JSON array of layers) is encoded here. |
| `data-ap-src` | The source geometry child the render-clones derive from. |
| `data-ap` | On a generated render clone: which layer type it paints (`fill` / `stroke`). |
| `data-ap-mask` | A generated `<mask>` for a *cut* (knockout) stroke — a white field minus the black cut shape. |
| `data-ap-group` | The generated `<g>` holding the clones that cut punches through; it wears the mask. |

### Variable-width strokes — `core/width-stroke.ts`, `core/variable-width.ts`
| Attribute | Meaning |
|---|---|
| `data-width` | Wrapper `<g>` marking a variable-width stroke. |
| `data-width-src` | Source centerline. |
| `data-width-render` | The regenerated outline `<path>`. |
| `data-width-profile` | The width profile (sample points). |
| `data-width-base` | Base stroke width. |
| `data-width-stroke` | The stroke COLOUR — the outline path is *filled* with it. Not a second wrapper marker. |

### Effects (blur/shadow) — `core/effects.ts`
`<filter>` lives in defs (regenerated); these parameters are the source of truth.
| Attribute | Meaning |
|---|---|
| `data-fx-blur` | Gaussian blur radius. |
| `data-fx-shadow` | Drop-shadow params (JSON: dx,dy,blur,color,opacity). |

### Blend mode — `core/wrapper-attrs.ts`, `core/compositing.ts`
| Attribute | Meaning |
|---|---|
| `data-blend` | The object's blend mode (`multiply`, `screen`, …; absent = normal). The source of truth. The inline `mix-blend-mode` style that actually renders it is written from this by `setBlend` and nowhere else, so saved and exported files still blend in other viewers. An object that arrives with only the inline style (an older document, imported SVG) is adopted on rebuild (`CompositingManager.ensureBlend`). |

### Stroke alignment — `core/stroke-align.ts`
| Attribute | Meaning |
|---|---|
| `data-stroke-align` | `inside` / `outside` (absent = center). Also lets `readStyle` recover the authored width; the emulating clip lives in defs. |

### Text styles — `core/text-styles.ts`
| Attribute | Meaning |
|---|---|
| `data-text-style` | Links a `<text>` to a style id in the library. |
| `data-styles` | The library JSON, on the `<metadata class="bq-text-styles">` carrier. |
| `data-line-height` | Per-text line height (drives tspan dy). |

### Area text (auto-wrapping text box) — `core/area-text.ts`, `tools/text.ts`
SVG has no native wrapping, so it is computed here: the raw text is the source of
truth and the `<tspan>` lines inside the `<text>` are a **regenerated word-wrap
cache** — `reflowAreaText()` rebuilds them on every width, typography, or content
change. All attributes + tspans, so it rides the snapshot for free.
| Attribute | Meaning |
|---|---|
| `data-area-text` | The canonical text: hard line breaks only, no wrap points. |
| `data-area-w` | Box width in world units. Its **presence is the marker** — `isAreaText()` tests exactly this. |
| `data-area-h` | Optional fixed height. Absent = auto-height (the Type tool only stores one for a drag of ≥ 20). |
| `data-area-valign` | `middle` / `bottom` vertical alignment inside a fixed-height box; absent = top. Offsets the first line's `dy`, never the box anchor, so `y` stays the top-aligned first baseline. |
| `data-area-overflow` | Derived, set to `1` on each reflow when the wrapped block is taller than the fixed height; removed when it fits. |

### Text on a path — `core/state.ts` (`typeTextOnPath`)
| Attribute | Meaning |
|---|---|
| `data-textpath` | Records the id of the path this `<text>` flows along. The *rendering* reference is the `<textPath href="#…">` child; the path stays a real sibling with `fill`/`stroke` cleared so it acts as an invisible baseline. |

### Clean text strokes (outline cache) — `core/text-stroke.ts`
Live-editor state only — **never persisted**. The browser strokes a live `<text>` with
visible glyph seams, so a stroked/`fill:none` text renders its stroke from a
regenerated outline `<path>` cached right behind it. `normalizeTextStrokesForExport()`
strips the cache path and the marker from the save/export clone, so a saved file is
plain `<text stroke=…>`; reopening re-derives them.
| Attribute | Meaning |
|---|---|
| `data-text-stroke-cache` | Marks the generated, id-less `<path>` inserted as the text's *previous* sibling, so it renders behind it (regenerated cache; `rebuildShapesFromDOM` skips it, so no phantom layer). |
| `data-text-stroke-outlined` | On the `<text>`: a global CSS rule keyed on it (`style.css`) suppresses the browser's own stroke. Deliberately NOT an inline style — `readStyle`'s `flattenInlineStyle` would flatten that onto the `stroke` attribute and clobber the real colour. |
| `data-geomsig` | The geometry signature the cache path was outlined at (content, font, transform, `x/y/dx/dy`, area box, + a font-load epoch). Gates the async re-outline: unchanged ⇒ only the stroke paint is re-applied. |

### Embedded fonts — `core/embedded-fonts.ts`
Fonts extracted from an imported PDF, so text renders in its real typeface. The
`FontFace` registrations are a **regenerated cache** like effect `<filter>`s —
`ensureFontFaces()` re-registers them with `document.fonts` after every rebuild.
| Attribute | Meaning |
|---|---|
| `data-fonts` | The library JSON (`{id, mime, b64}[]`, the font program base64-encoded), on the `<metadata class="bq-embedded-fonts">` carrier. Ids are content-derived, so identical bytes dedupe to one entry. |

### Asset Library (document tier) — `core/library.ts`
The generic document-scoped store for the asset types that lack a home of their own
(palettes, effect styles, paint styles). Text styles keep `bq-text-styles` (above);
components keep the `bq-symbols` carrier (below). Assets live only in the document;
the former account ("All files") tier left `origin`/`rev` provenance fields on some
assets, which are tolerated on read and never written.
| Attribute | Meaning |
|---|---|
| `data-assets` | The document library JSON (array of `LibraryAsset`), on the `<metadata class="bq-library">` carrier. |
| `data-seq` | The asset-id sequence, on the same carrier. **Persisted, never re-derived from the surviving assets** — deriving it reissued a deleted asset's id, and any shape still carrying that dead link joined the next style created. |

### Style links — `core/library-styles.ts` (`StyleLinkManager`)
Applying a library style stamps a link on the object so a later redefine/edit can
propagate to it. Links ride the history snapshot for free, are carried onto
appearance/width wrappers (`CARRY_ATTRS`), are stripped when the style is deleted,
and are pruned on paste when they name an asset this document doesn't have. A
manual edit detaches by RECONCILIATION — the link drops when the object stops
matching its definition — so every mutation path detaches, not just the setters
someone remembered to instrument. `AppState.devCheckStyleLinksInvariant()` logs
`[style-links]` in dev if any link fails to resolve. The attribute names live in one
table (`LINK_ATTR`); `CARRY_ATTRS` and the adapters derive from it.
| Attribute | Meaning |
|---|---|
| `data-paint-style` | Links a shape to a paint style (`asset-N-token`). |
| `data-effect-style` | Links a shape to an effect style. |

A paint style's ONE canonical gradient/pattern def is **not** a `data-*` attribute
(despite the `data-style-def` mentioned in `canonicalPaintDef`'s comment — no such
attribute is ever written). The def id is stored in the asset's `defId` payload field
and re-found by `styleDefElement()`.

### Components / symbols — `core/symbol-registry.ts`
A `<symbol>` lives in `<defs>`, which is **not** in the history snapshot, so the
definitions are carried in the drawing layer and the defs elements are regenerated
from them (the standard defs-are-a-cache rule). Without this, deleting a component
was unrecoverable artwork loss.
| Attribute | Meaning |
|---|---|
| `data-symbols` | JSON array of `<symbol>` markup, on the `<metadata class="bq-symbols">` carrier. |
| `data-seq` | Symbol-id sequence on that carrier (persisted, so ids never recycle). |
| `data-name` | The component's name, on the `<symbol>` (so it survives a rebuild). |
| `data-origin` / `data-rev` | Legacy provenance from the retired account library. Tolerated on read, never written. |

### Linked files — `core/linked-files.ts` (`LINK_ATTRS`)
A linked file still **materializes** its content into this document — the link is not
load-bearing for rendering, it only answers "is there a newer version?". So a missing
source degrades to a badge, never a hole. Storage is the wrapper-cache leaf pattern:
`<g data-linked-file>` is modeled as ONE layer (`detectType` → `linked`) and its
imported children are stripped of ids so they never become phantom layers. `embed()`
removes all four attributes, turning it into an ordinary group.
| Attribute | Meaning |
|---|---|
| `data-linked-file` | Marks the wrapper `<g>`. |
| `data-link-src` | The id of the source document. Sources lived in the retired cloud backend, so a link can no longer be opened or refreshed — Embed keeps the artwork. |
| `data-link-rev` | The source revision captured at placement/update. |
| `data-link-name` | The name the Layers row shows. |

### Clip / mask — `core/state.ts` (clipping), `ui/mask-*`, `ui/pathfinder.ts`
| Attribute | Meaning |
|---|---|
| `data-clip-group` | Wrapper `<g>` holding a clipped shape + its clip. |
| `data-bq-clip` | Marks the element acting as the clip. |
| `data-mask-preview` | Transient onion-skin of the masked-away region, injected into the drawing layer on Mask-button hover. `detectType` returns null for it and it's swept before the next snapshot. |
| `data-mask-dim` | Marks an object faded behind that preview (the ones the mask would clip); the value stores its original `opacity`. |

### Crop (raster) — `tools/crop.ts`
| Attribute | Meaning |
|---|---|
| `data-crop` | Nested `<svg data-crop viewBox>` leaf = a cropped raster image. |
| `data-crop-clip` | The inner `<svg>` of a crop that does the actual clipping (its box is its viewBox, 1:1). One level down because Chrome drops a nested svg's viewport clip once that svg is filtered — a blurred crop showed the whole picture. Added by `core/crop-clip.ts` to new crops, and to older ones when an effect is applied. No id; never a layer. |

### Flip — `core/state.ts`
| Attribute | Meaning |
|---|---|
| `data-flip` | Horizontal/vertical flip state folded into the transform. |

### Gradients — `core/paint-registry.ts`
The `<linearGradient>`/`<radialGradient>` defs are a regenerated cache like every
other def, so the models ride the snapshot on a `<metadata class="bq-paint">` carrier
inside the drawing layer. When the carrier is present it is **authoritative** over
defs (that's what makes a gradient survive undo); when absent — a legacy pre-carrier
document — the loaded model is kept and a carrier is written, so it can never blank a
fresh import.
| Attribute | Meaning |
|---|---|
| `data-gradients` | JSON array of `GradientDef`, on the carrier. |
| `data-grad-seq` | The gradient-id sequence, on the same carrier. Persisted, never re-derived — ids must not recycle. |

### Pattern fills — `core/paint-registry.ts`
`data-pat-type`, `data-pat-preset`, `data-pat-color`, `data-pat-scale`,
`data-pat-rotation`, `data-pat-spacing`, `data-pat-tw`, `data-pat-th`,
`data-pat-weight` — the parameters a `<pattern>` (in defs, regenerated) is rebuilt
from. `data-pat-weight` is the preset mark thickness in px (dot diameter for
`dots`), independent of scale/tile size; **absent** on patterns saved before it
existed, where `presetWeight()` reproduces the old scale-derived thickness so those
documents render unchanged.

The tiling and object-pattern params live alongside them on the `<pattern>`:
| Attribute | Meaning |
|---|---|
| `data-pat-tiletype` | How the tile repeats: `grid` (default) / `brick-row` / `brick-col`. SVG `<pattern>` has no native stagger, so brick is baked into an oversized tile. |
| `data-pat-tileoffset` | The brick stagger, 0–1 of a repeat (0.5 = the classic half-drop). Only meaningful for the brick types. |
| `data-pat-source` | LINKED pattern: the shape id the tile mirrors, so it re-captures on every rebuild. Absent ⇒ a plain copy. If the source disappears the id is dropped and the captured markup stays, so the fill freezes rather than breaking. |
| `data-pat-src` | Marks the FIRST placed cell inside the tile. An object pattern's artwork is read back out of it on import — the tile content IS the storage, so nothing extra is written and a saved file carries ordinary SVG. |

## Chrome attributes (editor UI only — never snapshotted or exported)

| Attribute | Where | Meaning |
|---|---|---|
| `data-tool` | `index.html` toolbar | Which tool a button activates (value = `ToolName`). |
| `data-action` | `index.html` menus | Which command a menu button runs (value = command id). |
| `data-handle` | `ui/selection-overlay.ts` | Resize/rotate handle id (`nw`/`se`/…). |
| `data-node-overlay`, `data-node-handle` | `ui/node-overlay.ts` | Path node-edit chrome. |
| `data-snap-guide` | `ui/*` | A rendered snapping guide line. |
| `data-frame-select` | overlays | Transient frame-selection chrome. (The `*-preview`/`*-dim` transients are injected into `#drawing-layer`, so they're documented above, not here.) |
| `data-node-anchor` | `ui/node-overlay.ts` | A path node anchor knob, `"subpath:index"`. |
| `data-ab-id`, `data-ab-handle` | `ui/frame-renderer.ts`, `tools/frame-tool.ts` | Frame resize-handle chrome — legacy "artboard" naming (see the frame/artboard split in `CLAUDE.md`). |
| `data-pf-boolsep`, `data-pf-masksep` | `ui/pathfinder.ts` | Popover separators. |
| `data-bool` | `ui/pathfinder.ts`, `index.html` | Which boolean op a pathfinder button runs. NOT the `data-boolean` wrapper. |
| `data-mask` | `ui/pathfinder.ts` | Marks the popover's Mask button. |
| `data-image-action` | `ui/image-actions.ts` | Contextual image-action button id. |
| `data-path-action` | `ui/path-actions.ts` | Contextual path-action button id. |
| `data-tooltip` | `ui/tooltip.ts` | Tooltip text for an element. |
| `data-tab` | `ui/tab-bar.ts` | Document-tab id. |
| `data-tab-id` | `ui/tab-bar.ts` | The same id on the rendered `.doc-tab`, so a live row can be re-found for an in-place rename. |
| `data-group` | `index.html` | Which split-pane a tab strip / new-doc button belongs to. |
| `data-id`, `data-depth` | `ui/layers.ts`, `ui/symbols-panel.ts` | List-row shape/symbol id, and the Layers row's nesting depth. |
| `data-align`, `data-distribute` | `ui/align.ts` | Alignment / distribution button id. |
| `data-anchor`, `data-valign` | `ui/properties.ts`, `index.html` | Text `text-anchor` and area-text vertical-align buttons. |
| `data-cap`, `data-join` | `ui/markers.ts`, `index.html` | Stroke line-cap / line-join buttons. |
| `data-profile` | `index.html` | Variable-width profile preset button. |
| `data-mode` | `ui/color-picker.ts` | Colour-model tab (hex/rgb/hsl…). |
| `data-grad-angle`, `data-grad-fx`, `data-grad-fy`, `data-grad-spread` | `ui/paint-editors.ts` | Gradient-editor controls (angle, radial focus, spread). |
| `data-asset-type` | `ui/library-panel.ts` | Which asset type a Library section holds. |
| `data-sp-key` | `ui/style-panel.ts` | Which style field an input edits. |
| `data-custom` | `core/canvas.ts` | The injected custom-value `<option>` in the zoom select. |
| `data-goto` | `ui/legal.ts` | Which legal section a tab jumps to. |
| `data-editor-chrome` | (contract only) | Opt-out marker: linked-file import skips any drawing-layer child carrying it. Nothing currently sets it — it's a forward guard for chrome that ever lands in the layer. |

The object-level attributes — what travels with an object whenever its element is
wrapped, unwrapped, replaced or dissolved — live in `core/wrapper-attrs.ts`
(`CARRY_ATTRS`): transform, clip, effects, blend, opacity, name, lock and the
library style links. Code never loops over that list itself; it calls
`carryObjectAttrs` (copy), `moveObjectAttrs` (copy, then strip the source that stays
in the document) or `dissolveOnto` / `foldOnto` (a container going away). Register a
new object-level attribute there as well as here, and it is carried everywhere.
