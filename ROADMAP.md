# BuzzQuill Feature Roadmap

> A phased plan to bring BuzzQuill's authoring capabilities in line with the full SVG specification.
>
> **Status note:** the "Current Baseline" below describes an early state and is kept
> for historical context. For what has actually shipped, see the
> [SVG Feature Coverage Checklist](#svg-feature-coverage-checklist) at the bottom —
> Phases 1–2 and Phase 4 are complete, and Phases 3 and 5 are largely done.

## Current Baseline (v0.0.0)

What BuzzQuill supports today:

- **Shapes:** rect, rounded-rect, ellipse, line, polyline, path (pen tool), polygon, star
- **Text:** basic text creation and editing with font properties
- **Styling:** fill, stroke, stroke-weight, opacity, corner radius, stroke caps/joins/dash patterns
- **Transforms:** move (translate) and resize only
- **Organization:** layers panel (z-order), multi-artboard support
- **Tools:** selection, direct selection, hand, zoom, eyedropper
- **I/O:** SVG import, SVG export, PNG export, project save/load (JSON)
- **Editing:** undo/redo (100 levels), duplicate, delete, alignment tools, rulers/grid

---

## Phase 1: Core Editing Foundations

**Goal:** Fill the most critical gaps that every design tool needs before adding effects.

### 1.1 - Group / Ungroup (`<g>` element)
- Group selected shapes into a `<g>` element
- Ungroup to dissolve a group back to individual shapes
- Nested groups support
- Group transforms apply to all children
- Double-click to enter group isolation mode
- Layers panel shows group hierarchy with expand/collapse
- **Success:** Users can organize shapes into logical groups and transform them as a unit

### 1.2 - Full Transform Support (rotate, scale, skew)
- Rotation handles on selection overlay (drag to rotate, shift-snap to 15-degree increments)
- Numeric rotation input in properties panel
- Scale from center (Alt+drag) vs scale from corner
- Skew handles or numeric skew input
- Transform origin control (9-point widget)
- `transform` attribute output in exported SVG
- **Success:** Arbitrary rotation/scale/skew via handles or numeric input; round-trips through SVG export/import

### 1.3 - Symbols and Reuse (`<symbol>`, `<use>`, `<defs>`)
- Create symbol from selection (stores in `<defs>`)
- Symbols panel listing all defined symbols
- Drag symbol instances onto canvas (creates `<use>` elements)
- Edit symbol definition; all instances update automatically
- Detach instance (convert `<use>` back to inline shapes)
- **Success:** Define once, reuse many times; editing the source updates all instances

### 1.4 - Embedded Images (`<image>` element)
- Drag-and-drop or file-picker to embed raster images (PNG, JPEG, WebP, GIF)
- Position, resize, and crop images on canvas
- `preserveAspectRatio` control in properties panel
- Data-URI embedding for self-contained SVG export
- **Success:** Users can place and manipulate raster images within their SVG compositions

---

## Phase 2: Paint & Fill Systems

**Goal:** Move beyond flat solid colors to the rich paint options SVG supports.

### 2.1 - Linear Gradients
- Gradient editor UI: add/remove/reposition color stops
- On-canvas gradient handle (drag start/end points)
- Apply to fill or stroke independently
- `spreadMethod` control (pad, reflect, repeat)
- `gradientUnits` toggle (objectBoundingBox vs userSpaceOnUse)
- Gradient stored in `<defs>` with `<linearGradient>` + `<stop>` elements
- **Success:** Create and edit multi-stop linear gradients visually; correct SVG output

### 2.2 - Radial Gradients
- Same stop editor as linear gradients
- On-canvas handles for center, radius, and focal point
- `fr` (focal radius) support (SVG 2)
- All gradient attributes: `cx`, `cy`, `r`, `fx`, `fy`, `spreadMethod`
- **Success:** Create and edit radial gradients with full control over center and focal point

### 2.3 - Pattern Fills
- Pattern editor: define a tile from shapes or images
- `patternUnits` and `patternContentUnits` controls
- `patternTransform` for rotating/scaling the pattern
- Preset pattern library (dots, stripes, crosshatch, etc.)
- **Success:** Fill shapes with repeating patterns; patterns survive export/import round-trip

---

## Phase 3: Visual Effects

**Goal:** Add non-destructive visual effects that are native to SVG.

### 3.1 - Filters: Blur & Drop Shadow
- Gaussian blur (`feGaussianBlur`) with numeric radius control
- Drop shadow (`feDropShadow` or composite filter chain) with dx, dy, blur, color
- Per-shape filter in properties panel
- Filter stored in `<defs>` with `<filter>` element
- **Success:** Apply blur and drop shadow to any shape; adjustable in properties panel

### 3.2 - Filters: Color Effects
- `feColorMatrix` for saturate, hue-rotate, brightness, contrast
- `feComponentTransfer` for per-channel curves/levels
- UI: sliders or a simplified color adjustment panel
- **Success:** Non-destructive color adjustments on any shape

### 3.3 - Filters: Advanced (Noise, Lighting, Morphology)
- `feTurbulence` for procedural noise/texture generation
- `feDiffuseLighting` / `feSpecularLighting` with light source controls
- `feMorphology` for erode/dilate effects
- `feDisplacementMap` for distortion effects
- `feConvolveMatrix` for sharpen/emboss/edge-detect
- Filter chain builder: visual pipeline connecting filter primitives
- **Success:** Power users can build complex multi-step filter pipelines

### 3.4 - Blend Modes & Compositing
- `mix-blend-mode` dropdown per shape (multiply, screen, overlay, etc.)
- `isolation` property for group compositing control
- `opacity` already supported; ensure it interacts correctly with blend modes
- **Success:** Standard Photoshop/Illustrator blend modes available per shape

---

## Phase 4: Clipping, Masking & Markers

**Goal:** Advanced composition techniques for precise visual control.

### 4.1 - Clip Paths (`<clipPath>`)
- "Set as clip path" from selected shape(s)
- Apply clip path to target shape or group
- Edit clip path shape in isolation mode
- `clip-rule` toggle (nonzero / evenodd)
- **Success:** Hard-edge clipping of any shape using another shape as boundary

### 4.2 - Masks (`<mask>`)
- "Set as mask" from selected shape(s)
- Luminance masking (white = visible, black = hidden, gray = partial)
- Alpha masking option (`mask-type: alpha`)
- Edit mask contents in isolation mode
- **Success:** Soft-edge masking with gradient transparency

### 4.3 - Markers (Arrowheads & Endpoints)
- `<marker>` element creation and management
- Preset marker library (arrows, circles, diamonds, squares)
- Apply to `marker-start`, `marker-mid`, `marker-end` independently
- Custom marker editor (draw your own marker shape)
- `orient: auto` and fixed-angle rotation
- **Success:** Lines and paths can have arrowheads and decorative endpoints

---

## Phase 5: Advanced Text

**Goal:** Bring text capabilities up to SVG's full potential.

### 5.1 - Rich Text (`<tspan>` support)
- Mixed styling within a single text element (bold a word, color a phrase)
- Multi-line text with proper `<tspan>` elements and dy offsets
- `text-anchor` and `dominant-baseline` controls
- `letter-spacing` and `word-spacing` adjustments
- `text-decoration` (underline, strikethrough)
- **Success:** Style individual runs of text differently within one text element

### 5.2 - Text on Path (`<textPath>`)
- Attach text to any `<path>` element
- `startOffset` slider to position text along the path
- `side` control (SVG 2) for text on opposite side of path
- Edit path independently while text follows
- **Success:** Text flows along arbitrary curves

### 5.3 - Wrapped Text (SVG 2)
- `inline-size` for auto-wrapping text within a width
- `shape-inside` for flowing text into arbitrary shapes
- **Note:** Browser support is limited; may need fallback rendering
- **Success:** Text wraps naturally within a defined area or shape

---

## Phase 6: Animation

**Goal:** Support SVG's native animation capabilities.

### 6.1 - Timeline & SMIL Animation
- Timeline panel at the bottom of the UI
- Keyframe-based animation of any numeric attribute (position, size, opacity, color)
- `<animate>`, `<animateTransform>`, `<set>` element generation
- Play/pause/scrub controls
- `calcMode` options (linear, spline, discrete, paced)
- `repeatCount` and `fill` (freeze/remove) controls
- **Success:** Create time-based animations that play in any browser via SMIL

### 6.2 - Motion Paths (`<animateMotion>`)
- Draw or select a path for an element to follow
- `rotate: auto` for automatic orientation along path
- `keyPoints` for non-uniform timing along the path
- Preview animation in editor
- **Success:** Animate elements along arbitrary curves

### 6.3 - CSS Animation Export
- Export animations as CSS `@keyframes` instead of / in addition to SMIL
- Wider browser compatibility
- **Success:** Animated SVGs that work in environments where SMIL is limited

---

## Phase 7: Interactivity & Metadata

**Goal:** Round out the feature set with interactivity, accessibility, and metadata.

### 7.1 - Hyperlinks (`<a>` element)
- Wrap shapes/groups in `<a>` with `href` and `target`
- Visual indicator in editor for linked elements
- **Success:** Exported SVGs contain clickable regions

### 7.2 - Accessibility
- `<title>` and `<desc>` editing per shape/group in properties panel
- `role` attribute support (img, graphics-document, graphics-object)
- `aria-label` and `aria-labelledby` wiring
- **Success:** Exported SVGs are screen-reader friendly

### 7.3 - Metadata
- Document-level `<title>`, `<desc>`, `<metadata>` editing
- Custom `data-*` attributes panel for advanced users
- SVG namespace and doctype configuration for export
- **Success:** Exported SVGs carry proper metadata for SEO and cataloging

### 7.4 - foreignObject (HTML Embedding)
- Insert HTML content block within SVG via `<foreignObject>`
- Rich text editing, form elements, or arbitrary HTML
- **Note:** Primarily useful for web-targeted SVGs; not universally rendered
- **Success:** Embed HTML islands within SVG documents

---

## Phase Summary

| Phase | Theme | Key Deliverables | Complexity |
|-------|-------|-----------------|------------|
| **1** | Core Editing | Groups, full transforms, symbols, images | Medium |
| **2** | Paint Systems | Linear gradients, radial gradients, patterns | Medium |
| **3** | Visual Effects | Blur, shadows, color effects, blend modes, filter builder | High |
| **4** | Clipping & Masking | Clip paths, masks, markers/arrowheads | Medium-High |
| **5** | Advanced Text | Rich text, text on path, wrapped text | Medium |
| **6** | Animation | Timeline, SMIL, motion paths, CSS animation | Very High |
| **7** | Interactivity | Links, accessibility, metadata, foreignObject | Low-Medium |

---

## Dependencies & Ordering Notes

- **Phase 1 should come first** -- groups and transforms are foundational; later phases assume they exist.
- **Phase 2 before Phase 3** -- the gradient/pattern UI patterns inform the filter UI design.
- **Phases 4 and 5 are independent** of each other and can be done in either order.
- **Phase 6 (animation)** is the largest undertaking and benefits from all prior phases being stable.
- **Phase 7** has no hard dependencies and items can be sprinkled in alongside other phases.
- Within each phase, sub-items are ordered by dependency (e.g., 2.1 linear gradients before 2.2 radial gradients).

---

## SVG Feature Coverage Checklist

After all phases, BuzzQuill will support authoring of:

- [x] Basic shapes (rect, circle, ellipse, line, polyline, polygon, path)
- [x] Star / regular polygon
- [x] Text (basic)
- [x] Fill & stroke styling
- [x] Opacity
- [x] Stroke dash patterns, caps, joins
- [x] Layers / z-ordering
- [x] Artboards
- [x] **Phase 1:** Groups (`<g>`), full transforms, symbols (`<symbol>`/`<use>`), images (`<image>`)
- [x] **Phase 2:** Linear gradients, radial gradients, pattern fills
- [~] **Phase 3:** Blur + drop shadow ✅, blend modes ✅ — color-matrix / noise / lighting filters still pending
- [x] **Phase 4:** Clip paths, masks, markers
- [~] **Phase 5:** Text on path ✅, document-scoped text styles ✅ — rich-text `<tspan>` runs and wrapped text still pending
- [ ] **Phase 6:** SMIL animation, motion paths, CSS animation export
- [ ] **Phase 7:** Hyperlinks, accessibility, metadata, foreignObject

> Beyond the phases above, the editor has also shipped non-destructive boolean
> pathfinding, variable-width strokes, an appearance stack (multiple fills/strokes),
> raster crop, PDF import (raster + editable vector), and direct Google Drive
> open/save. The app needs no server to run.
