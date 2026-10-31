// Living design-system reference page (`npm run design-system`).
//
// It loads the SHIPPING stylesheet (src/style.css) and renders the real design
// tokens + components, so it can never drift from the app:
//   - Colour & dimension tokens are auto-discovered from the `--ai-*` custom
//     properties declared on :root (add a token in style.css → it appears here).
//   - Icons are imported from the same module the app uses (ui/icons.ts).
//   - Components are built from the real CSS classes.
import './style.css';
import {
  ICON_EXPORT, ICON_EYE, ICON_EYE_OFF, ICON_LOCK, ICON_UNLOCK,
  getShapeIcon, SHAPE_ICON_TYPES,
} from './ui/icons';
import { escapeHtml } from './ui/dom';
import { sliderField } from './ui/slider-field';

// ---- Token discovery ------------------------------------------------------

interface Token { name: string; value: string; }

/** Read every `--*` custom property declared on a :root rule, across all sheets. */
function readRootTokens(): Token[] {
  const out = new Map<string, string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && /(^|,|\s):root(\s|,|$)/.test(rule.selectorText)) {
        const style = rule.style;
        for (let i = 0; i < style.length; i++) {
          const prop = style[i];
          if (prop.startsWith('--')) out.set(prop, style.getPropertyValue(prop).trim());
        }
      }
    }
  }
  return Array.from(out, ([name, value]) => ({ name, value }));
}

const isColor = (v: string) => /^#|^rgb|^hsl/i.test(v);
const isDimension = (v: string) => /(px|rem|em|vh|vw|%)$/.test(v);

// ---- Rendering helpers ----------------------------------------------------


function section(title: string, note: string, bodyHTML: string): string {
  return `<section class="ds-section">
    <h2 class="ds-h2">${escapeHtml(title)}</h2>
    ${note ? `<p class="ds-note">${escapeHtml(note)}</p>` : ''}
    <div class="ds-grid">${bodyHTML}</div>
  </section>`;
}

function colorSwatch(t: Token): string {
  // A tick of the swatch on both a dark and light strip so we can see it in context.
  return `<figure class="ds-card ds-swatch">
    <div class="ds-swatch-chip" style="background:${t.value}"></div>
    <figcaption><code>${escapeHtml(t.name)}</code><span class="ds-mono">${escapeHtml(t.value)}</span></figcaption>
  </figure>`;
}

function dimSwatch(t: Token): string {
  const px = parseFloat(t.value) || 0;
  const w = Math.max(2, Math.min(px, 260));
  return `<figure class="ds-card">
    <div class="ds-dimbar" style="width:${w}px"></div>
    <figcaption><code>${escapeHtml(t.name)}</code><span class="ds-mono">${escapeHtml(t.value)}</span></figcaption>
  </figure>`;
}

function iconTile(label: string, svg: string): string {
  return `<figure class="ds-card ds-icon-tile">
    <div class="ds-icon">${svg}</div>
    <figcaption><span class="ds-mono">${escapeHtml(label)}</span></figcaption>
  </figure>`;
}

/** A Layers-panel row built from the real classes + shared icons. */
function layerRow(opts: { name: string; type: string; group?: boolean; child?: boolean; collapsed?: boolean; selected?: boolean; hidden?: boolean; locked?: boolean }): string {
  const cls = ['layer-item'];
  if (opts.child) cls.push('layer-child');
  if (opts.group) cls.push('layer-group');
  if (opts.selected) cls.push('selected');
  const vis = opts.hidden ? ICON_EYE_OFF : ICON_EYE;
  const lock = opts.locked ? ICON_LOCK : ICON_UNLOCK;
  const lockCls = opts.locked ? 'layer-lock' : 'layer-lock unlocked';
  const indent = opts.child ? '<span class="layer-indent" style="width:14px;min-width:14px"></span>' : '';
  const disclosure = opts.group
    ? `<span class="layer-group-toggle">${opts.collapsed ? '&#x25B6;' : '&#x25BC;'}</span>`
    : (opts.child ? '<span class="layer-tree-connector"></span>' : '');
  return `<li class="${cls.join(' ')}">
    <span class="layer-vis">${vis}</span>
    <span class="${lockCls}">${lock}</span>
    ${indent}${disclosure}
    <span class="layer-icon">${getShapeIcon(opts.type)}</span>
    <span class="layer-name">${escapeHtml(opts.name)}</span>
  </li>`;
}

function chip(key: string, label: string): string {
  return `<span class="gesture-hud-chip"><kbd>${escapeHtml(key)}</kbd><span class="gesture-hud-label">${escapeHtml(label)}</span></span>`;
}

// ---- Build the page -------------------------------------------------------

function build(): void {
  const tokens = readRootTokens();
  const colors = tokens.filter(t => isColor(t.value));
  const dims = tokens.filter(t => !isColor(t.value) && isDimension(t.value));

  const fontSizes = [
    { px: 10, use: 'micro labels, dims' },
    { px: 11, use: 'secondary / shortcuts' },
    { px: 12, use: 'body (default)' },
    { px: 15, use: 'toggle icons / inputs' },
  ];
  const typographyHTML = fontSizes.map(f => `<figure class="ds-card">
    <div style="font-size:${f.px}px; color:var(--ai-text-bright)">The quick brown fox</div>
    <figcaption><code>${f.px}px</code><span class="ds-mono">${escapeHtml(f.use)}</span></figcaption>
  </figure>`).join('') + `<figure class="ds-card">
    <div style="color:var(--ai-text-bright)">
      <span style="font-weight:400">Regular 400</span> ·
      <span style="font-weight:500">Medium 500</span> ·
      <span style="font-weight:600">Semibold 600</span>
    </div>
    <figcaption><span class="ds-mono">system-ui / Segoe UI / SF</span></figcaption>
  </figure>`;

  const shapeIconsHTML = SHAPE_ICON_TYPES.map(t => iconTile(t, getShapeIcon(t))).join('');
  const toggleIconsHTML = [
    iconTile('eye', ICON_EYE), iconTile('eye-off', ICON_EYE_OFF),
    iconTile('lock', ICON_LOCK), iconTile('unlock', ICON_UNLOCK),
    iconTile('export', ICON_EXPORT),
  ].join('');

  // Components — real classes, with position overrides for the normally-floating ones.
  const layersDemo = `<figure class="ds-card ds-wide">
    <ul class="ds-panel-surface" style="list-style:none">
      ${layerRow({ name: 'polygon #7', type: 'polygon', selected: true })}
      ${layerRow({ name: 'Group #6', type: 'group', group: true })}
      ${layerRow({ name: 'polygon #5', type: 'polygon', child: true })}
      ${layerRow({ name: 'polygon #4', type: 'polygon', child: true, hidden: true })}
      ${layerRow({ name: 'polygon #3', type: 'polygon', child: true, locked: true })}
    </ul>
    <figcaption><span class="ds-mono">.layer-item — toggles in a fixed left column</span></figcaption>
  </figure>`;

  // Collapsible panel header: chevron pinned left, label, optional right-aligned
  // action (+). One click on the chevron or a double-click on the bar collapses it.
  const panelHeaderDemo = `<figure class="ds-card ds-wide">
    <div class="panel" style="background:var(--ai-panel-dark)">
      <div class="panel-header">
        <span>Layers</span>
        <button class="panel-add" title="Add" aria-hidden="true">&#x2b;</button>
        <button class="panel-collapse" aria-hidden="true">&#x25BC;</button>
      </div>
    </div>
    <figcaption><span class="ds-mono">.panel-header — chevron left, + right; dbl-click bar to collapse</span></figcaption>
  </figure>`;

  const hudDemo = `<figure class="ds-card">
    <div class="tool-hint gesturing" style="position:static;margin:0">${chip('Shift', 'straight')}${chip('⌘', 'ignore guides')}</div>
    <figcaption><span class="ds-mono">.tool-hint.gesturing — the same strip during a drag (ui/gesture-hud.ts)</span></figcaption>
  </figure>`;

  const hintDemo = `<figure class="ds-card">
    <div class="tool-hint" style="position:static;margin:0">${chip('Double-click', 'edit points')}<button type="button" class="gesture-hud-chip accent"><kbd>⌘J</kbd><span class="gesture-hud-label">close path</span></button></div>
    <figcaption><span class="ds-mono">.tool-hint — what the active tool can do right now (ui/tool-hint.ts)</span></figcaption>
  </figure>`;

  const togglesDemo = `<figure class="ds-card">
    <div class="ds-toggle-row"><span>Off</span><button class="ai-switch" role="switch" aria-checked="false" aria-label="demo off"></button></div>
    <div class="ds-toggle-row"><span style="color:var(--ai-text-bright)">On</span><button class="ai-switch" role="switch" aria-checked="true" aria-label="demo on"></button></div>
    <figcaption><span class="ds-mono">.ai-switch — createToggle() / setToggle() · a boolean setting</span></figcaption>
  </figure>
  <figure class="ds-card">
    <div class="dlg-seg">
      <button class="dlg-seg-btn active"><span class="dlg-seg-label">Outlines</span><span class="dlg-seg-hint">paths</span></button>
      <button class="dlg-seg-btn"><span class="dlg-seg-label">Live text</span><span class="dlg-seg-hint">editable</span></button>
    </div>
    <figcaption><span class="ds-mono">.dlg-seg — a segmented either/or choice</span></figcaption>
  </figure>`;

  const menuDemo = `<figure class="ds-card">
    <div class="menu-panel" style="display:block;position:static;box-shadow:none">
      <button>New<span class="shortcut">⌘N</span></button>
      <button>Save<span class="shortcut">⌘S</span></button>
      <div class="menu-divider"></div>
      <button class="checked">Show Grid</button>
      <button class="disabled">Paste</button>
    </div>
    <figcaption><span class="ds-mono">.menu-panel</span></figcaption>
  </figure>`;

  const inputsDemo = `<figure class="ds-card">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <label class="num-scrub" style="color:var(--ai-text-dim)">W:</label>
      <input type="number" value="120" style="width:64px;height:24px;background:var(--ai-input);color:var(--ai-text);border:1px solid var(--ai-border-light);border-radius:3px;padding:0 6px" />
      <input type="text" value="Untitled" style="height:24px;background:var(--ai-input);color:var(--ai-text);border:1px solid var(--ai-border-light);border-radius:3px;padding:0 8px" />
    </div>
    <figcaption><span class="ds-mono">numeric / text fields (scrub label = ew-resize)</span></figcaption>
  </figure>`;

  // The value field is attached by the real component once the markup is in.
  const sliderDemo = `<figure class="ds-card ds-wide">
    <div class="appearance-row" style="margin:0">
      <span class="appearance-label">Opacity</span>
      <input type="range" id="ds-slider" class="appearance-slider" min="0" max="1" step="0.01" value="0.8" title="Opacity" />
    </div>
    <figcaption><span class="ds-mono">sliderField() — every slider gets a typeable value, never a read-only readout</span></figcaption>
  </figure>`;

  const swatchColorDemo = `<figure class="ds-card">
    <div style="display:flex;gap:8px;align-items:center">
      <span class="layer-color"></span><span class="layer-color layer-color-group"></span>
      <span style="color:var(--ai-danger)">danger</span>
      <span style="color:var(--ai-accent)">accent</span>
    </div>
    <figcaption><span class="ds-mono">.layer-color / accent / danger</span></figcaption>
  </figure>`;

  const root = document.getElementById('ds-root')!;
  root.innerHTML = `
    <header class="ds-header">
      <h1 class="ds-h1">SVGMaker — Design System</h1>
      <p class="ds-sub">Live reference rendered from the shipping <code>style.css</code> and <code>ui/icons.ts</code>. Tokens auto-discovered from <code>:root</code>.</p>
    </header>
    <main class="ds-main">
      ${section('Colour tokens', `${colors.length} custom properties from :root`, colors.map(colorSwatch).join(''))}
      ${section('Dimension tokens', 'Layout metrics (toolbar, rulers, panels, bars)', dims.map(dimSwatch).join(''))}
      ${section('Typography', 'System UI stack; the sizes and weights the app actually uses', typographyHTML)}
      ${section('Shape / layer icons', 'ui/icons.ts — getShapeIcon(type)', shapeIconsHTML)}
      ${section('Toggle & action icons', 'Monochrome, inherit currentColor; lock is filled when locked', toggleIconsHTML)}
      ${section('Toggles', 'Boolean setting → switch; either/or choice → segmented. Click to try them.', togglesDemo)}
      ${section('Components', 'Built from the real CSS classes', panelHeaderDemo + layersDemo + menuDemo + hudDemo + hintDemo + inputsDemo + sliderDemo + swatchColorDemo)}
    </main>`;
  const dsSlider = document.getElementById('ds-slider') as HTMLInputElement;
  dsSlider.after(sliderField(dsSlider, { scale: 100, unit: '%' }));

  // Make the toggle demos live so the reference behaves like the real controls.
  root.addEventListener('click', (e) => {
    const sw = (e.target as Element).closest('.ai-switch');
    if (sw) { sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); return; }
    const seg = (e.target as Element).closest('.dlg-seg-btn');
    if (seg?.parentElement) seg.parentElement.querySelectorAll('.dlg-seg-btn').forEach(b => b.classList.toggle('active', b === seg));
  });
}

// Page-shell styling (uses the app's own tokens so the reference matches the product).
const shell = document.createElement('style');
shell.textContent = `
  /* The app's style.css locks html/body to 100% height + overflow:hidden (it's a
     fixed full-screen editor). This is a normal scrolling document, so undo that.
     !important because in dev Vite may inject style.css after this shell <style>. */
  html, body { height:auto !important; min-height:100%; overflow:visible !important; }
  body { margin:0; background:var(--ai-bg); color:var(--ai-text);
    font-family: system-ui, 'Segoe UI', sans-serif; font-size:12px; }
  .ds-header { padding:28px 32px 8px; }
  .ds-h1 { margin:0; font-size:22px; font-weight:600; color:var(--ai-text-bright); }
  .ds-sub { margin:6px 0 0; color:var(--ai-text-dim); font-size:12px; }
  .ds-sub code, .ds-note code { color:var(--ai-text-bright); }
  .ds-main { padding:8px 32px 64px; }
  .ds-section { margin:28px 0; }
  .ds-h2 { font-size:13px; text-transform:uppercase; letter-spacing:.6px;
    color:var(--ai-text-bright); border-bottom:1px solid var(--ai-border); padding-bottom:6px; margin:0 0 4px; }
  .ds-note { margin:0 0 14px; color:var(--ai-text-dim); }
  .ds-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:12px; }
  .ds-card { margin:0; background:var(--ai-panel); border:1px solid var(--ai-border);
    border-radius:6px; padding:12px; display:flex; flex-direction:column; gap:10px; overflow:hidden; }
  .ds-card.ds-wide { grid-column:1 / -1; max-width:340px; }
  .ds-card figcaption { display:flex; flex-direction:column; gap:2px; }
  .ds-card code { color:var(--ai-text-bright); font-size:11px; }
  .ds-mono { color:var(--ai-text-dim); font-size:11px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .ds-swatch-chip { height:56px; border-radius:4px; border:1px solid rgba(255,255,255,.08); }
  .ds-dimbar { height:12px; background:var(--ai-accent); border-radius:3px; }
  .ds-icon-tile .ds-icon { height:44px; display:flex; align-items:center; justify-content:center;
    color:var(--ai-text); background:var(--ai-panel-darker); border-radius:4px; }
  .ds-icon svg { width:22px; height:22px; }
  .ds-panel-surface { margin:0; padding:0; background:var(--ai-panel-dark);
    border:1px solid var(--ai-border); border-radius:4px; }
  .ds-toggle-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
`;
document.head.appendChild(shell);

build();
