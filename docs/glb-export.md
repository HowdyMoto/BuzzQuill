# SVG to GLB export

Open Export Frames and choose **GLB 3D model**. The 3D dialog accepts a document,
frame, or the selection captured when the dialog opens. Choose geometry and
material sources, set a physical width and thickness, then **Build preview**.
**Export GLB** saves the exact preview model with embedded PNG textures. Changing
any export option disables saving until a fresh preview is built.

The dialog groups the essentials into **Shape & size** and **Surface**. Optional
layer maps open beneath each finish control; channels and inversion appear only
when a map is selected. With a map, the finish value is labelled **Unpainted** to
explain that it controls uncovered pixels. **Details** holds back/edge materials
and quality. Color swatches only appear when their solid-color option is active.
The desktop preview stays visible; narrow windows provide **Jump to preview**
and **Settings** links within one scroll area. Preview badges distinguish not
built, building, ready, changes not previewed and errors. Disclosures and state
feedback respect reduced-motion preferences; artwork never auto-rotates.

The model is centred on the origin in metres, with the front facing +Z. Width
sets uniform scale; height follows the shape or selected frame's aspect ratio.
Frame width starts at 96 SVG pixels per inch. Thickness is independent of width.
The back can share the planar artwork projection (text reads backwards from
behind) or have a solid color. Side walls have independent color, roughness and
metallic values.

## Materials

Base color can use visible artwork, an explicit layer/group, or a solid color.
Roughness and metallic independently accept vector, raster, or mixed groups.
Explicit sources may be hidden in the editor. Their transforms and document
positions are retained. All channels share the geometry's export rectangle;
small map patches are never independently stretched to fit the object.

For roughness, black is smooth and white rough. For metallic, black is nonmetal
and white metal. Grayscale uses weighted RGB byte values without sRGB decoding,
so #808080 is approximately 0.5. Channels R/G/B/Alpha and inversion are available.
Transparent pixels blend with the chosen fallback; Alpha-channel mode directly
uses coverage as the data value. Separate maps are packed into green (roughness)
and blue (metallic), with linear sampling. Base-color textures use sRGB.

Map-source layers are excluded from automatic geometry and base-color baking.
An explicit color source is also excluded from automatic geometry. To reuse a
layer for geometry and material data, select it explicitly for both roles.
Images contribute appearance, not silhouettes; supply a vector outline.

## Geometry and limits

**Solid silhouette** is the default geometry mode. Closed vector contours become
solid front/back faces even when their SVG fill is `none`; their stroke does not
expand the silhouette. Open paths still use their stroke outlines. Choose
**Visible fills and strokes** to retain hollow stroked borders instead.
For a photo cutout, select its closed outline as Geometry source and its raster
image as Base color source. This fills the interior with the image on both caps
without adding a fill to the original artwork. Empty frame backgrounds are not
treated as silhouettes.

Fills preserve SVG fill rules and holes. Overlapping regions are united before
extrusion, and strokes are outlined, including caps, joins and dash patterns.
Vector clipping and transforms are applied; holes receive inner side walls.
Available text is outlined for geometry and material baking. Unresolved fonts,
linked raster images and missing source layers produce errors rather than partial
exports. Filters and soft masks affect surface appearance only and generate a
geometry warning. Symbol instances (`use`), foreignObject, arrowhead markers and non-scaling strokes
must be converted to ordinary paths before geometry export.

Draft/Standard/High choose curve sampling quality. Texture size is 512–4096 pixels
on the longest edge. The output is a single self-contained glTF 2.0 binary file.
Bevels, per-layer depths, height/displacement maps and raster silhouette tracing
are outside this version. GLB is a rendering interchange format, not a CAD solid.

The selected frame's right-hand Export panel also offers **GLB**. Expand its
options to set width, thickness and units. **Materials & 3D preview** opens the
full editor; build the preview, then choose **Save frame settings**. These settings
are saved with the frame's export target in the SVG and used by the frame's
Export button and batch frame export. The target's filename is used for the GLB.
Standalone dialog options are remembered per scope during the current document session. Export uses a
captured snapshot, never mutates drawing markup/history, and remains tied to that
snapshot if the active document changes. A canceled dialog never writes a file.

## Implementation and checks

- `glb-source`: synchronous snapshot, scoped clones, isolated SVG measurement.
- `glb-geometry`: fill/stroke conversion, boolean union and clipping.
- `glb-material`: shared-coordinate raster baking and linear channel packing.
- `glb-export`: mesh construction, normals/UVs, resource disposal and serialization.
- `glb-dialog` / `glb-preview`: lazy-loaded controls and orbitable PBR preview.

The browser tests validate ring surface area/volume, watertight edges, physical
dimensions, winding, packed material pixels, transformed clips, real dialog
downloads and cancellation. Generated output is checked with Khronos's glTF
validator. Run `npx playwright test test/glb-export.spec.ts` on an isolated port
using `BQ_TEST_PORT`.
