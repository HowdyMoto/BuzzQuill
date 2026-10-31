/**
 * Bundled designer fonts (self-hosted via @fontsource, so they work offline and
 * their files are available for outlining/embedding on export). Importing each
 * stylesheet registers its @font-face; the FONTS list drives the font picker.
 *
 * Static families import a CURATED weight ladder (Light 300 → Bold 700, + italics
 * where they exist) via per-weight `latin-<w>.css` files, rather than the full
 * `latin.css` (every 100–900 face) — so Bold, Light, and Italic are real faces (not
 * browser-synthesized) while the bundled woff2 count drops ~40% (~17 MB → ~8 MB).
 * Variable families load one wght-100–900 woff2 instead. Faces load lazily
 * (font-display:swap), so only the weights actually used are fetched. FONT_WEIGHTS
 * drives the weight picker, which offers only the faces that ship. Export
 * outlining/embedding still uses the 400 master.
 */

import robotoVar from '@fontsource-variable/roboto/files/roboto-latin-standard-normal.woff2?url';
import robotoVarI from '@fontsource-variable/roboto/files/roboto-latin-standard-italic.woff2?url';
import openSansVar from '@fontsource-variable/open-sans/files/open-sans-latin-standard-normal.woff2?url';
import openSansVarI from '@fontsource-variable/open-sans/files/open-sans-latin-standard-italic.woff2?url';
// Variable-font URLs (loaded as a single woff2 spanning wght 100–900, plus width/
// optical axes) — these families don't ship the static ladder below.
import interVar from '@fontsource-variable/inter/files/inter-latin-standard-normal.woff2?url';
import interVarI from '@fontsource-variable/inter/files/inter-latin-standard-italic.woff2?url';
import archivoVar from '@fontsource-variable/archivo/files/archivo-latin-standard-normal.woff2?url';
import archivoVarI from '@fontsource-variable/archivo/files/archivo-latin-standard-italic.woff2?url';
import dmSansVar from '@fontsource-variable/dm-sans/files/dm-sans-latin-standard-normal.woff2?url';
import dmSansVarI from '@fontsource-variable/dm-sans/files/dm-sans-latin-standard-italic.woff2?url';
import merriVar from '@fontsource-variable/merriweather/files/merriweather-latin-standard-normal.woff2?url';
import merriVarI from '@fontsource-variable/merriweather/files/merriweather-latin-standard-italic.woff2?url';
import geistVar from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url';
import geistVarI from '@fontsource-variable/geist/files/geist-latin-wght-italic.woff2?url';
// The same variable faces as plain TTF, decoded from the WOFF2 at build time (see
// the woff2-to-ttf plugin in vite.config.ts), for OUTLINING: opentype.js reads TTF,
// not WOFF2, and a static file is only one fixed instance of the design.
import robotoTtf from '@fontsource-variable/roboto/files/roboto-latin-standard-normal.woff2?ttf';
import robotoTtfI from '@fontsource-variable/roboto/files/roboto-latin-standard-italic.woff2?ttf';
import openSansTtf from '@fontsource-variable/open-sans/files/open-sans-latin-standard-normal.woff2?ttf';
import openSansTtfI from '@fontsource-variable/open-sans/files/open-sans-latin-standard-italic.woff2?ttf';
import interTtf from '@fontsource-variable/inter/files/inter-latin-standard-normal.woff2?ttf';
import interTtfI from '@fontsource-variable/inter/files/inter-latin-standard-italic.woff2?ttf';
import archivoTtf from '@fontsource-variable/archivo/files/archivo-latin-standard-normal.woff2?ttf';
import archivoTtfI from '@fontsource-variable/archivo/files/archivo-latin-standard-italic.woff2?ttf';
import dmSansTtf from '@fontsource-variable/dm-sans/files/dm-sans-latin-standard-normal.woff2?ttf';
import dmSansTtfI from '@fontsource-variable/dm-sans/files/dm-sans-latin-standard-italic.woff2?ttf';
import merriTtf from '@fontsource-variable/merriweather/files/merriweather-latin-standard-normal.woff2?ttf';
import merriTtfI from '@fontsource-variable/merriweather/files/merriweather-latin-standard-italic.woff2?ttf';
import geistTtf from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?ttf';
import geistTtfI from '@fontsource-variable/geist/files/geist-latin-wght-italic.woff2?ttf';

// Static families ship a CURATED weight ladder (Light 300 → Bold 700, + italics
// where the family has them) rather than every 100–900 face — cutting the bundled
// woff2 count ~40% (~17 MB → ~8 MB of static assets) while keeping all 31 families.
// The weight picker offers only these (FONT_WEIGHTS), and its nearest-weight
// fallback maps a requested Thin/Black onto the closest shipped face. Faces still
// load lazily (font-display:swap), so only the weights actually used are fetched.
import '@fontsource/montserrat/latin-300.css';
import '@fontsource/montserrat/latin-300-italic.css';
import '@fontsource/montserrat/latin-400.css';
import '@fontsource/montserrat/latin-400-italic.css';
import '@fontsource/montserrat/latin-500.css';
import '@fontsource/montserrat/latin-500-italic.css';
import '@fontsource/montserrat/latin-600.css';
import '@fontsource/montserrat/latin-600-italic.css';
import '@fontsource/montserrat/latin-700.css';
import '@fontsource/montserrat/latin-700-italic.css';
import '@fontsource/lato/latin-300.css';
import '@fontsource/lato/latin-300-italic.css';
import '@fontsource/lato/latin-400.css';
import '@fontsource/lato/latin-400-italic.css';
import '@fontsource/lato/latin-700.css';
import '@fontsource/lato/latin-700-italic.css';
import '@fontsource/poppins/latin-300.css';
import '@fontsource/poppins/latin-300-italic.css';
import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-400-italic.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/poppins/latin-500-italic.css';
import '@fontsource/poppins/latin-600.css';
import '@fontsource/poppins/latin-600-italic.css';
import '@fontsource/poppins/latin-700.css';
import '@fontsource/poppins/latin-700-italic.css';
import '@fontsource/raleway/latin-300.css';
import '@fontsource/raleway/latin-300-italic.css';
import '@fontsource/raleway/latin-400.css';
import '@fontsource/raleway/latin-400-italic.css';
import '@fontsource/raleway/latin-500.css';
import '@fontsource/raleway/latin-500-italic.css';
import '@fontsource/raleway/latin-600.css';
import '@fontsource/raleway/latin-600-italic.css';
import '@fontsource/raleway/latin-700.css';
import '@fontsource/raleway/latin-700-italic.css';
import '@fontsource/nunito/latin-300.css';
import '@fontsource/nunito/latin-300-italic.css';
import '@fontsource/nunito/latin-400.css';
import '@fontsource/nunito/latin-400-italic.css';
import '@fontsource/nunito/latin-500.css';
import '@fontsource/nunito/latin-500-italic.css';
import '@fontsource/nunito/latin-600.css';
import '@fontsource/nunito/latin-600-italic.css';
import '@fontsource/nunito/latin-700.css';
import '@fontsource/nunito/latin-700-italic.css';
import '@fontsource/roboto-condensed/latin-300.css';
import '@fontsource/roboto-condensed/latin-300-italic.css';
import '@fontsource/roboto-condensed/latin-400.css';
import '@fontsource/roboto-condensed/latin-400-italic.css';
import '@fontsource/roboto-condensed/latin-500.css';
import '@fontsource/roboto-condensed/latin-500-italic.css';
import '@fontsource/roboto-condensed/latin-600.css';
import '@fontsource/roboto-condensed/latin-600-italic.css';
import '@fontsource/roboto-condensed/latin-700.css';
import '@fontsource/roboto-condensed/latin-700-italic.css';
import '@fontsource/source-sans-3/latin-300.css';
import '@fontsource/source-sans-3/latin-300-italic.css';
import '@fontsource/source-sans-3/latin-400.css';
import '@fontsource/source-sans-3/latin-400-italic.css';
import '@fontsource/source-sans-3/latin-500.css';
import '@fontsource/source-sans-3/latin-500-italic.css';
import '@fontsource/source-sans-3/latin-600.css';
import '@fontsource/source-sans-3/latin-600-italic.css';
import '@fontsource/source-sans-3/latin-700.css';
import '@fontsource/source-sans-3/latin-700-italic.css';
import '@fontsource/work-sans/latin-300.css';
import '@fontsource/work-sans/latin-300-italic.css';
import '@fontsource/work-sans/latin-400.css';
import '@fontsource/work-sans/latin-400-italic.css';
import '@fontsource/work-sans/latin-500.css';
import '@fontsource/work-sans/latin-500-italic.css';
import '@fontsource/work-sans/latin-600.css';
import '@fontsource/work-sans/latin-600-italic.css';
import '@fontsource/work-sans/latin-700.css';
import '@fontsource/work-sans/latin-700-italic.css';
import '@fontsource/rubik/latin-300.css';
import '@fontsource/rubik/latin-300-italic.css';
import '@fontsource/rubik/latin-400.css';
import '@fontsource/rubik/latin-400-italic.css';
import '@fontsource/rubik/latin-500.css';
import '@fontsource/rubik/latin-500-italic.css';
import '@fontsource/rubik/latin-600.css';
import '@fontsource/rubik/latin-600-italic.css';
import '@fontsource/rubik/latin-700.css';
import '@fontsource/rubik/latin-700-italic.css';
import '@fontsource/quicksand/latin-300.css';
import '@fontsource/quicksand/latin-400.css';
import '@fontsource/quicksand/latin-500.css';
import '@fontsource/quicksand/latin-600.css';
import '@fontsource/quicksand/latin-700.css';
import '@fontsource/josefin-sans/latin-300.css';
import '@fontsource/josefin-sans/latin-300-italic.css';
import '@fontsource/josefin-sans/latin-400.css';
import '@fontsource/josefin-sans/latin-400-italic.css';
import '@fontsource/josefin-sans/latin-500.css';
import '@fontsource/josefin-sans/latin-500-italic.css';
import '@fontsource/josefin-sans/latin-600.css';
import '@fontsource/josefin-sans/latin-600-italic.css';
import '@fontsource/josefin-sans/latin-700.css';
import '@fontsource/josefin-sans/latin-700-italic.css';
import '@fontsource/barlow/latin-300.css';
import '@fontsource/barlow/latin-300-italic.css';
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-400-italic.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-500-italic.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow/latin-600-italic.css';
import '@fontsource/barlow/latin-700.css';
import '@fontsource/barlow/latin-700-italic.css';
import '@fontsource/space-grotesk/latin-300.css';
import '@fontsource/space-grotesk/latin-400.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-600.css';
import '@fontsource/space-grotesk/latin-700.css';
import '@fontsource/playfair-display/latin-400.css';
import '@fontsource/playfair-display/latin-400-italic.css';
import '@fontsource/playfair-display/latin-500.css';
import '@fontsource/playfair-display/latin-500-italic.css';
import '@fontsource/playfair-display/latin-600.css';
import '@fontsource/playfair-display/latin-600-italic.css';
import '@fontsource/playfair-display/latin-700.css';
import '@fontsource/playfair-display/latin-700-italic.css';
import '@fontsource/libre-baskerville/latin-400.css';
import '@fontsource/libre-baskerville/latin-400-italic.css';
import '@fontsource/libre-baskerville/latin-500.css';
import '@fontsource/libre-baskerville/latin-500-italic.css';
import '@fontsource/libre-baskerville/latin-600.css';
import '@fontsource/libre-baskerville/latin-600-italic.css';
import '@fontsource/libre-baskerville/latin-700.css';
import '@fontsource/libre-baskerville/latin-700-italic.css';
import '@fontsource/pt-serif/latin-400.css';
import '@fontsource/pt-serif/latin-400-italic.css';
import '@fontsource/pt-serif/latin-700.css';
import '@fontsource/pt-serif/latin-700-italic.css';
import '@fontsource/oswald/latin-300.css';
import '@fontsource/oswald/latin-400.css';
import '@fontsource/oswald/latin-500.css';
import '@fontsource/oswald/latin-600.css';
import '@fontsource/oswald/latin-700.css';
import '@fontsource/bebas-neue/latin-400.css';
import '@fontsource/anton/latin-400.css';
import '@fontsource/lobster/latin-400.css';
import '@fontsource/dancing-script/latin-400.css';
import '@fontsource/dancing-script/latin-500.css';
import '@fontsource/dancing-script/latin-600.css';
import '@fontsource/dancing-script/latin-700.css';
import '@fontsource/pacifico/latin-400.css';
import '@fontsource/caveat/latin-400.css';
import '@fontsource/caveat/latin-500.css';
import '@fontsource/caveat/latin-600.css';
import '@fontsource/caveat/latin-700.css';
import '@fontsource/roboto-mono/latin-300.css';
import '@fontsource/roboto-mono/latin-300-italic.css';
import '@fontsource/roboto-mono/latin-400.css';
import '@fontsource/roboto-mono/latin-400-italic.css';
import '@fontsource/roboto-mono/latin-500.css';
import '@fontsource/roboto-mono/latin-500-italic.css';
import '@fontsource/roboto-mono/latin-600.css';
import '@fontsource/roboto-mono/latin-600-italic.css';
import '@fontsource/roboto-mono/latin-700.css';
import '@fontsource/roboto-mono/latin-700-italic.css';

// Monospace. Roboto Mono was the only one; these are the families people actually
// reach for when they want code/technical type — Geist Mono especially, to pair
// with the Geist sans already bundled.
import '@fontsource/geist-mono/latin-300.css';
import '@fontsource/geist-mono/latin-300-italic.css';
import '@fontsource/geist-mono/latin-400.css';
import '@fontsource/geist-mono/latin-400-italic.css';
import '@fontsource/geist-mono/latin-500.css';
import '@fontsource/geist-mono/latin-500-italic.css';
import '@fontsource/geist-mono/latin-600.css';
import '@fontsource/geist-mono/latin-600-italic.css';
import '@fontsource/geist-mono/latin-700.css';
import '@fontsource/geist-mono/latin-700-italic.css';
import '@fontsource/jetbrains-mono/latin-300.css';
import '@fontsource/jetbrains-mono/latin-300-italic.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-400-italic.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-500-italic.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import '@fontsource/jetbrains-mono/latin-600-italic.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import '@fontsource/jetbrains-mono/latin-700-italic.css';
import '@fontsource/fira-code/latin-300.css';
import '@fontsource/fira-code/latin-400.css';
import '@fontsource/fira-code/latin-500.css';
import '@fontsource/fira-code/latin-600.css';
import '@fontsource/fira-code/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-300.css';
import '@fontsource/ibm-plex-mono/latin-300-italic.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-400-italic.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-500-italic.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-600-italic.css';
import '@fontsource/ibm-plex-mono/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-700-italic.css';
import '@fontsource/source-code-pro/latin-300.css';
import '@fontsource/source-code-pro/latin-300-italic.css';
import '@fontsource/source-code-pro/latin-400.css';
import '@fontsource/source-code-pro/latin-400-italic.css';
import '@fontsource/source-code-pro/latin-500.css';
import '@fontsource/source-code-pro/latin-500-italic.css';
import '@fontsource/source-code-pro/latin-600.css';
import '@fontsource/source-code-pro/latin-600-italic.css';
import '@fontsource/source-code-pro/latin-700.css';
import '@fontsource/source-code-pro/latin-700-italic.css';
import '@fontsource/space-mono/latin-400.css';
import '@fontsource/space-mono/latin-400-italic.css';
import '@fontsource/space-mono/latin-700.css';
import '@fontsource/space-mono/latin-700-italic.css';
import '@fontsource/inconsolata/latin-300.css';
import '@fontsource/inconsolata/latin-400.css';
import '@fontsource/inconsolata/latin-500.css';
import '@fontsource/inconsolata/latin-600.css';
import '@fontsource/inconsolata/latin-700.css';

// Raw .woff (WOFF1) URLs for each family — used to outline text (opentype.js) or
// embed the font in an exported SVG. opentype.js parses WOFF1 but not WOFF2, so we
// deliberately import the .woff (not .woff2) files here.
// opentype.js (~200 KB) is only needed to outline text or read font features —
// never at first paint. Import its *types* eagerly (erased at build time) and
// load the engine lazily on first use, so it stays out of the startup bundle.
import type * as OpenType from 'opentype.js';
import uRoboto from '@fontsource/roboto/files/roboto-latin-400-normal.woff?url';
import uOpenSans from '@fontsource/open-sans/files/open-sans-latin-400-normal.woff?url';
import uMontserrat from '@fontsource/montserrat/files/montserrat-latin-400-normal.woff?url';
import uLato from '@fontsource/lato/files/lato-latin-400-normal.woff?url';
import uPoppins from '@fontsource/poppins/files/poppins-latin-400-normal.woff?url';
import uInter from '@fontsource/inter/files/inter-latin-400-normal.woff?url';
import uRaleway from '@fontsource/raleway/files/raleway-latin-400-normal.woff?url';
import uNunito from '@fontsource/nunito/files/nunito-latin-400-normal.woff?url';
import uRobotoCondensed from '@fontsource/roboto-condensed/files/roboto-condensed-latin-400-normal.woff?url';
import uSourceSans3 from '@fontsource/source-sans-3/files/source-sans-3-latin-400-normal.woff?url';
import uWorkSans from '@fontsource/work-sans/files/work-sans-latin-400-normal.woff?url';
import uRubik from '@fontsource/rubik/files/rubik-latin-400-normal.woff?url';
import uQuicksand from '@fontsource/quicksand/files/quicksand-latin-400-normal.woff?url';
import uJosefinSans from '@fontsource/josefin-sans/files/josefin-sans-latin-400-normal.woff?url';
import uArchivo from '@fontsource/archivo/files/archivo-latin-400-normal.woff?url';
import uBarlow from '@fontsource/barlow/files/barlow-latin-400-normal.woff?url';
import uDmSans from '@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff?url';
import uSpaceGrotesk from '@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff?url';
import uPlayfairDisplay from '@fontsource/playfair-display/files/playfair-display-latin-400-normal.woff?url';
import uMerriweather from '@fontsource/merriweather/files/merriweather-latin-400-normal.woff?url';
import uLibreBaskerville from '@fontsource/libre-baskerville/files/libre-baskerville-latin-400-normal.woff?url';
import uPtSerif from '@fontsource/pt-serif/files/pt-serif-latin-400-normal.woff?url';
import uOswald from '@fontsource/oswald/files/oswald-latin-400-normal.woff?url';
import uBebasNeue from '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff?url';
import uAnton from '@fontsource/anton/files/anton-latin-400-normal.woff?url';
import uLobster from '@fontsource/lobster/files/lobster-latin-400-normal.woff?url';
import uDancingScript from '@fontsource/dancing-script/files/dancing-script-latin-400-normal.woff?url';
import uPacifico from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url';
import uCaveat from '@fontsource/caveat/files/caveat-latin-400-normal.woff?url';
import uRobotoMono from '@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff?url';
import uGeist from '@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff?url';
import uGeistMono from '@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff?url';
import uJetBrainsMono from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff?url';
import uFiraCode from '@fontsource/fira-code/files/fira-code-latin-400-normal.woff?url';
import uIBMPlexMono from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff?url';
import uSourceCodePro from '@fontsource/source-code-pro/files/source-code-pro-latin-400-normal.woff?url';
import uSpaceMono from '@fontsource/space-mono/files/space-mono-latin-400-normal.woff?url';
import uInconsolata from '@fontsource/inconsolata/files/inconsolata-latin-400-normal.woff?url';

// A handful of families load their VARIABLE font (instead of the static weight ladder)
// so their extra axes — width, optical size — are editable via font-variation-settings.
// @fontsource-variable registers these as "<Name> Variable"; we re-declare each under
// its BASE family name so existing font-family values keep working. Weight still comes
// from the wght axis via the CSS font-weight property, so the weight slider is unchanged.
// Width/optical are the only NEW controls (the wght-only variable families keep their
// static faces). Outlining these families reads the SAME variable face, through
// loadVariableOutlineFont: a static file is one fixed instance, and the browser draws
// Inter at 48px with the opsz-32 display design, not the static opsz-14 text one.
const VARIABLE_FACES: { family: string; normal: string; italic: string; ttf: string; ttfItalic: string }[] = [
  { family: 'Roboto', normal: robotoVar, italic: robotoVarI, ttf: robotoTtf, ttfItalic: robotoTtfI },
  { family: 'Open Sans', normal: openSansVar, italic: openSansVarI, ttf: openSansTtf, ttfItalic: openSansTtfI },
  { family: 'Inter', normal: interVar, italic: interVarI, ttf: interTtf, ttfItalic: interTtfI },
  { family: 'Archivo', normal: archivoVar, italic: archivoVarI, ttf: archivoTtf, ttfItalic: archivoTtfI },
  { family: 'DM Sans', normal: dmSansVar, italic: dmSansVarI, ttf: dmSansTtf, ttfItalic: dmSansTtfI },
  { family: 'Merriweather', normal: merriVar, italic: merriVarI, ttf: merriTtf, ttfItalic: merriTtfI },
  { family: 'Geist', normal: geistVar, italic: geistVarI, ttf: geistTtf, ttfItalic: geistTtfI },
];
if (typeof document !== 'undefined') {
  const css = VARIABLE_FACES.map((f) =>
    `@font-face{font-family:'${f.family}';src:url(${f.normal}) format('woff2-variations');font-weight:100 900;font-style:normal;font-display:swap;}` +
    `@font-face{font-family:'${f.family}';src:url(${f.italic}) format('woff2-variations');font-weight:100 900;font-style:italic;font-display:swap;}`,
  ).join('');
  const style = document.createElement('style');
  style.id = 'variable-font-faces';
  style.textContent = css;
  document.head.appendChild(style);
}

/** A non-weight variable axis a family exposes (weight stays on the discrete slider). */
export interface FontAxis { tag: 'wdth' | 'opsz'; label: string; min: number; max: number; default: number; }
const FONT_AXES: Record<string, FontAxis[]> = {
  'Roboto': [{ tag: 'wdth', label: 'Width', min: 75, max: 100, default: 100 }],
  'Open Sans': [{ tag: 'wdth', label: 'Width', min: 75, max: 100, default: 100 }],
  'Inter': [{ tag: 'opsz', label: 'Optical size', min: 14, max: 32, default: 14 }],
  'Archivo': [{ tag: 'wdth', label: 'Width', min: 62, max: 125, default: 100 }],
  'DM Sans': [{ tag: 'opsz', label: 'Optical size', min: 9, max: 40, default: 14 }],
  'Merriweather': [
    { tag: 'wdth', label: 'Width', min: 87, max: 112, default: 100 },
    { tag: 'opsz', label: 'Optical size', min: 18, max: 144, default: 18 },
  ],
};

/** The non-weight variable axes a family supports (empty for static fonts). */
export function getFontAxes(family: string): FontAxis[] {
  const first = (family || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  return FONT_AXES[first] ?? [];
}

export type FontCategory = 'Sans Serif' | 'Serif' | 'Display' | 'Handwriting' | 'Monospace';

export interface FontDef {
  /** Must match the @font-face family name @fontsource registers. */
  family: string;
  category: FontCategory;
}

export const FONTS: FontDef[] = [
  // Sans Serif — Inter first: the default, a full-suite modern variable font.
  { family: 'Inter', category: 'Sans Serif' },
  { family: 'Geist', category: 'Sans Serif' },
  { family: 'Roboto', category: 'Sans Serif' },
  { family: 'Open Sans', category: 'Sans Serif' },
  { family: 'Montserrat', category: 'Sans Serif' },
  { family: 'Poppins', category: 'Sans Serif' },
  { family: 'Lato', category: 'Sans Serif' },
  { family: 'Raleway', category: 'Sans Serif' },
  { family: 'Nunito', category: 'Sans Serif' },
  { family: 'Work Sans', category: 'Sans Serif' },
  { family: 'Source Sans 3', category: 'Sans Serif' },
  { family: 'Rubik', category: 'Sans Serif' },
  { family: 'DM Sans', category: 'Sans Serif' },
  { family: 'Space Grotesk', category: 'Sans Serif' },
  { family: 'Archivo', category: 'Sans Serif' },
  { family: 'Barlow', category: 'Sans Serif' },
  { family: 'Quicksand', category: 'Sans Serif' },
  { family: 'Josefin Sans', category: 'Sans Serif' },
  { family: 'Roboto Condensed', category: 'Sans Serif' },
  // Serif
  { family: 'Playfair Display', category: 'Serif' },
  { family: 'Merriweather', category: 'Serif' },
  { family: 'Libre Baskerville', category: 'Serif' },
  { family: 'PT Serif', category: 'Serif' },
  // Display
  { family: 'Oswald', category: 'Display' },
  { family: 'Bebas Neue', category: 'Display' },
  { family: 'Anton', category: 'Display' },
  { family: 'Lobster', category: 'Display' },
  // Handwriting
  { family: 'Dancing Script', category: 'Handwriting' },
  { family: 'Pacifico', category: 'Handwriting' },
  { family: 'Caveat', category: 'Handwriting' },
  // Monospace
  { family: 'Roboto Mono', category: 'Monospace' },
  { family: 'Geist Mono', category: 'Monospace' },
  { family: 'JetBrains Mono', category: 'Monospace' },
  { family: 'Fira Code', category: 'Monospace' },
  { family: 'IBM Plex Mono', category: 'Monospace' },
  { family: 'Source Code Pro', category: 'Monospace' },
  { family: 'Space Mono', category: 'Monospace' },
  { family: 'Inconsolata', category: 'Monospace' },
];

/** Real weight/italic faces each bundled family ships (derived from its @fontsource
 *  package). Drives the weight picker so it offers only faces that actually exist. */
// VARIABLE families (Roboto, Open Sans, Inter, Archivo, DM Sans, Merriweather) keep
// their full range — one variable woff2 covers every weight at no extra file cost.
// STATIC families are CURATED to Light 300 → Bold 700 (the shipped faces); the picker
// offers only these.
const FONT_WEIGHTS: Record<string, { weights: number[]; italic: boolean }> = {
  'Roboto': { weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], italic: true },
  'Open Sans': { weights: [300, 400, 500, 600, 700, 800], italic: true },
  'Montserrat': { weights: [300, 400, 500, 600, 700], italic: true },
  'Lato': { weights: [300, 400, 700], italic: true },
  'Poppins': { weights: [300, 400, 500, 600, 700], italic: true },
  'Inter': { weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], italic: true },
  'Raleway': { weights: [300, 400, 500, 600, 700], italic: true },
  'Nunito': { weights: [300, 400, 500, 600, 700], italic: true },
  'Roboto Condensed': { weights: [300, 400, 500, 600, 700], italic: true },
  'Source Sans 3': { weights: [300, 400, 500, 600, 700], italic: true },
  'Work Sans': { weights: [300, 400, 500, 600, 700], italic: true },
  'Rubik': { weights: [300, 400, 500, 600, 700], italic: true },
  'Quicksand': { weights: [300, 400, 500, 600, 700], italic: false },
  'Josefin Sans': { weights: [300, 400, 500, 600, 700], italic: true },
  'Archivo': { weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], italic: true },
  'Barlow': { weights: [300, 400, 500, 600, 700], italic: true },
  'DM Sans': { weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], italic: true },
  'Geist': { weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], italic: true },
  'Space Grotesk': { weights: [300, 400, 500, 600, 700], italic: false },
  'Playfair Display': { weights: [400, 500, 600, 700], italic: true },
  'Merriweather': { weights: [300, 400, 500, 600, 700, 800, 900], italic: true },
  'Libre Baskerville': { weights: [400, 500, 600, 700], italic: true },
  'PT Serif': { weights: [400, 700], italic: true },
  'Oswald': { weights: [300, 400, 500, 600, 700], italic: false },
  'Bebas Neue': { weights: [400], italic: false },
  'Anton': { weights: [400], italic: false },
  'Lobster': { weights: [400], italic: false },
  'Dancing Script': { weights: [400, 500, 600, 700], italic: false },
  'Pacifico': { weights: [400], italic: false },
  'Caveat': { weights: [400, 500, 600, 700], italic: false },
  'Roboto Mono': { weights: [300, 400, 500, 600, 700], italic: true },
  'Geist Mono': { weights: [300, 400, 500, 600, 700], italic: true },
  'JetBrains Mono': { weights: [300, 400, 500, 600, 700], italic: true },
  'Fira Code': { weights: [300, 400, 500, 600, 700], italic: false },
  'IBM Plex Mono': { weights: [300, 400, 500, 600, 700], italic: true },
  'Source Code Pro': { weights: [300, 400, 500, 600, 700], italic: true },
  'Space Mono': { weights: [400, 700], italic: true },
  'Inconsolata': { weights: [300, 400, 500, 600, 700], italic: false },
};

/** CSS font-weight → the name typographers use, for the weight picker. */
export const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular',
  500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
};

/** First family token, unquoted (font-family may be a list / quoted). */
function firstFamily(family: string): string {
  return (family || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
}

/** The weights a family actually has faces for. System/unknown fonts → Regular + Bold. */
export function availableWeights(family: string): number[] {
  return FONT_WEIGHTS[firstFamily(family)]?.weights ?? [400, 700];
}

/** Normalize a font-weight value (keyword or number) to a numeric weight. */
export function normalizeWeight(v: string | number | undefined | null): number {
  if (v === 'bold') return 700;
  if (v === 'normal' || v == null) return 400;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 400;
}

const SYSTEM_FONTS = ['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New'];
const CATEGORY_ORDER: FontCategory[] = ['Sans Serif', 'Serif', 'Display', 'Handwriting', 'Monospace'];

/** Grouped family list (System first, then each category) for the custom font picker. */
export function fontMenuGroups(): { label: string; families: string[] }[] {
  const groups: { label: string; families: string[] }[] = [{ label: 'System', families: SYSTEM_FONTS.slice() }];
  for (const cat of CATEGORY_ORDER) {
    groups.push({ label: cat, families: FONTS.filter((f) => f.category === cat).map((f) => f.family) });
  }
  return groups;
}

/** Bundled WOFF1 file URL for each family, for outlining/embedding on export. */
const FONT_FILES: Record<string, string> = {
  'Roboto': uRoboto,
  'Open Sans': uOpenSans,
  'Montserrat': uMontserrat,
  'Lato': uLato,
  'Poppins': uPoppins,
  'Inter': uInter,
  'Raleway': uRaleway,
  'Nunito': uNunito,
  'Roboto Condensed': uRobotoCondensed,
  'Source Sans 3': uSourceSans3,
  'Work Sans': uWorkSans,
  'Rubik': uRubik,
  'Quicksand': uQuicksand,
  'Josefin Sans': uJosefinSans,
  'Archivo': uArchivo,
  'Barlow': uBarlow,
  'DM Sans': uDmSans,
  'Space Grotesk': uSpaceGrotesk,
  'Playfair Display': uPlayfairDisplay,
  'Merriweather': uMerriweather,
  'Libre Baskerville': uLibreBaskerville,
  'PT Serif': uPtSerif,
  'Oswald': uOswald,
  'Bebas Neue': uBebasNeue,
  'Anton': uAnton,
  'Lobster': uLobster,
  'Dancing Script': uDancingScript,
  'Pacifico': uPacifico,
  'Caveat': uCaveat,
  'Roboto Mono': uRobotoMono,
  'Geist Mono': uGeistMono,
  'JetBrains Mono': uJetBrainsMono,
  'Fira Code': uFiraCode,
  'IBM Plex Mono': uIBMPlexMono,
  'Source Code Pro': uSourceCodePro,
  'Space Mono': uSpaceMono,
  'Inconsolata': uInconsolata,
  'Geist': uGeist,
};

// Static WOFF1 files per weight/style, for OUTLINING at the right weight/italic.
// opentype.js can't read the variable WOFF2 faces used for rendering, so we outline
// from @fontsource's static files. Globbed (not hand-imported) so each family brings
// exactly the weights/styles it ships — a missing variant simply isn't in the map,
// no build error. `?url` keeps these out of the JS bundle; each is fetched on demand.
const OUTLINE_GLOB = import.meta.glob(
  '/node_modules/@fontsource/*/files/*-latin-{100,200,300,400,500,600,700,800,900}-{normal,italic}.woff',
  { query: '?url', import: 'default', eager: true },
) as Record<string, string>;

interface OutlineVariant { weight: number; italic: boolean; url: string; }
const OUTLINE_VARIANTS = new Map<string, OutlineVariant[]>();
for (const [path, url] of Object.entries(OUTLINE_GLOB)) {
  const slug = path.match(/@fontsource\/([^/]+)\/files\//)?.[1];
  const m = path.match(/-latin-(\d+)-(normal|italic)\.woff$/);
  if (!slug || !m) continue;
  const list = OUTLINE_VARIANTS.get(slug) ?? [];
  list.push({ weight: parseInt(m[1], 10), italic: m[2] === 'italic', url });
  OUTLINE_VARIANTS.set(slug, list);
}

/** @fontsource package slug for a bundled display family (all derive by lowercasing
 *  + hyphenating, except Geist whose package is 'geist-sans'). */
function familyToSlug(family: string): string {
  return family === 'Geist' ? 'geist-sans' : family.toLowerCase().replace(/\s+/g, '-');
}

/** Nearest outline file to the requested weight in the requested style; falls back to
 *  the other style when the family ships none for it (e.g. Geist has no static italic —
 *  the glyphs come out upright rather than failing). Null if the family isn't bundled. */
function pickOutlineUrl(family: string, weight: number, italic: boolean): string | null {
  const all = OUTLINE_VARIANTS.get(familyToSlug(family));
  if (!all || all.length === 0) return null;
  const styled = all.filter(v => v.italic === italic);
  const pool = styled.length ? styled : all;
  return pool.reduce((best, v) => Math.abs(v.weight - weight) < Math.abs(best.weight - weight) ? v : best).url;
}

/** Map common system / generic font names to the nearest bundled family for outlining. */
const SYSTEM_FALLBACK: Record<string, string> = {
  'arial': 'Roboto',
  'helvetica': 'Roboto',
  'sans-serif': 'Roboto',
  'georgia': 'PT Serif',
  'times': 'PT Serif',
  'times new roman': 'PT Serif',
  'serif': 'PT Serif',
  'courier': 'Roboto Mono',
  'courier new': 'Roboto Mono',
  'monospace': 'Roboto Mono',
};

/** Resolve a font-family value to a bundled family name we have a file for (or null). */
export function resolveBundledFamily(family: string): string | null {
  // font-family can be a list ("'Foo', sans-serif") or quoted — take the first token.
  const first = (family || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  if (FONT_FILES[first]) return first;
  const fallback = SYSTEM_FALLBACK[first.toLowerCase()];
  return fallback && FONT_FILES[fallback] ? fallback : null;
}

// Lazily load the opentype.js engine (a dynamic import → its own chunk), cached
// after the first call so repeated outline/feature lookups don't re-import.
let opentypeModP: Promise<typeof import('opentype.js')> | null = null;
function getOpentype(): Promise<typeof import('opentype.js')> {
  return (opentypeModP ??= import('opentype.js'));
}

const fontCache = new Map<string, Promise<OpenType.Font>>();

/** Load (and cache) the opentype.js Font for a family at the given weight/style,
 *  resolving system fonts to a bundled equivalent. Weight/italic pick the nearest
 *  static file the family ships (see pickOutlineUrl); default is 400 upright. */
export function loadOpentypeFont(family: string, weight = 400, italic = false): Promise<OpenType.Font> | null {
  const resolved = resolveBundledFamily(family);
  if (!resolved) return null;
  const url = pickOutlineUrl(resolved, weight, italic) ?? FONT_FILES[resolved];
  if (!url) return null;
  let p = fontCache.get(url);
  if (!p) {
    p = fetch(url)
      .then(r => r.arrayBuffer())
      .then(async buf => (await getOpentype()).parse(buf));
    fontCache.set(url, p);
  }
  return p;
}

/**
 * Load (and cache) an opentype.js Font from raw sfnt BYTES rather than a bundled
 * URL — used for fonts embedded in the document (e.g. extracted from an imported
 * PDF), which have no file on disk and no entry in FONT_FILES. `key` is the
 * content-derived family id, so the parse happens once per font per session.
 */
export function loadOpentypeFontFromBytes(key: string, bytes: Uint8Array): Promise<OpenType.Font> {
  let p = fontCache.get(key);
  if (!p) {
    // Copy into a standalone ArrayBuffer: opentype.parse reads from byteOffset 0,
    // and a subarray view would silently decode the wrong region.
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    p = getOpentype().then(ot => ot.parse(buf));
    fontCache.set(key, p);
  }
  return p;
}

/**
 * The variable face a bundled family RENDERS with (see VARIABLE_FACES), for
 * outlining; null for a family that renders from static files. Outlining has to
 * take the instance the browser drew — opsz from the font size, wght from the
 * weight — which opentype.js does from this face (`getPath(…, { variation })`),
 * where a static file could only ever give its one built-in instance.
 */
export function loadVariableOutlineFont(family: string, italic = false): Promise<OpenType.Font> | null {
  const face = VARIABLE_FACES.find((f) => f.family === firstFamily(family));
  if (!face) return null;
  const url = italic ? face.ttfItalic : face.ttf;
  let p = fontCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then(async (buf) => (await getOpentype()).parse(buf));
    fontCache.set(url, p);
  }
  return p;
}

/** OpenType layout-feature tags a font provides (from its GSUB table), so the panel
 *  can offer only features the font actually supports. Empty for non-bundled families. */
export function getFontFeatures(family: string): Promise<Set<string>> {
  const p = loadOpentypeFont(family);
  if (!p) return Promise.resolve(new Set());
  return p.then((font) => {
    const tags = new Set<string>();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const feats = (font as any).tables?.gsub?.features;
    if (Array.isArray(feats)) for (const f of feats) { if (f?.tag) tags.add(f.tag); }
    return tags;
  }).catch(() => new Set<string>());
}

const dataUrlCache = new Map<string, Promise<string>>();

/** Fetch a bundled family's WOFF as a base64 data: URL (for @font-face embedding). Null if not bundled. */
export function loadFontDataUrl(family: string): Promise<string> | null {
  const resolved = resolveBundledFamily(family);
  if (!resolved) return null;
  const url = FONT_FILES[resolved];
  let p = dataUrlCache.get(url);
  if (!p) {
    p = fetch(url)
      .then(r => r.arrayBuffer())
      .then(buf => {
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return `data:font/woff;base64,${btoa(binary)}`;
      });
    dataUrlCache.set(url, p);
  }
  return p;
}
