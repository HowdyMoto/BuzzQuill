import type { AppState } from '../../core/state';
import type { ShapeData } from '../../core/types';

import { readTextLines, writeTextLines, releaseImportedTextWidth } from '../../core/text-lines';
import { isAreaText, reflowAreaText, setAreaVAlign, areaVAlign, type AreaVAlign } from '../../core/area-text';
import { fontMenuGroups, normalizeWeight } from '../../fonts';
import { setupFontPicker, setFontPickerValue } from '../font-picker';
import { setupWeightSlider, setWeightSlider } from '../weight-slider';
import { setupOpenType, setOpenType } from '../opentype-controls';
import { setupAxisSliders, setAxisSliders } from '../axis-sliders';
import { bindLiveCommit } from '../dom';

import { common, MIXED } from '../../core/shape-props';

import { reversePathData } from '../../core/path-model';
import { flipTextSpan } from '../../core/path-direction';

import { MIXED_HINT, setNumField, setToggle } from './fields';

/** The <text> element the type controls should edit: the shape itself when it's a
 *  plain text, or the hidden [data-ap-src] source <text> inside a multi-stroke
 *  (appearance) wrapper. Null for anything that isn't text-backed. */
function textTarget(shape: ShapeData): SVGTextElement | null {
  if (shape.type === 'text') return shape.element as unknown as SVGTextElement;
  if (shape.type === 'appearance') {
    const src = shape.element.querySelector(':scope > [data-ap-src]');
    if (src && src.tagName.toLowerCase() === 'text') return src as unknown as SVGTextElement;
  }
  return null;
}

/** True when the object is text-backed (plain text or a multi-stroke text wrapper).
 *  Exported so the inspector shows the Text panel for ANY all-text selection (one or
 *  many) — the panel's read + apply paths are already multi-selection aware. */
export function isTextShape(shape: ShapeData): boolean { return !!textTarget(shape); }

/** Re-show the Text panel for a multi-stroke text (an `appearance` wrapper whose
 *  source is a <text>), which the inspector — keyed to type 'text' — otherwise hides.
 *  Must run AFTER updateInspector in the state-change cycle. */
export function syncTextPanelVisibility(state: AppState): void {
  const ids = state.selectedShapeIds;
  if (ids.length !== 1) return;
  const shape = state.findShapeById(ids[0]);
  if (shape && shape.type === 'appearance' && isTextShape(shape)) {
    const p = document.getElementById('panel-type');
    if (p) p.style.display = '';
  }
}

export function setupTextProperties(state: AppState): void {
  // Text properties are ONE thing, so fold the separate "Type settings" panel's rows
  // into the Character panel and drop the extra panel. (index.html still carries them as
  // two panels — another agent is mid-refactor there — so we consolidate at runtime;
  // the moved controls keep their ids/listeners, and inspector's now-dead
  // show('panel-type-advanced') is a harmless no-op on the removed element.)
  const advPanel = document.getElementById('panel-type-advanced');
  const charBody = document.querySelector('#panel-type .panel-body');
  const advBody = advPanel?.querySelector('.panel-body');
  if (advPanel && charBody && advBody) {
    while (advBody.firstChild) charBody.appendChild(advBody.firstChild);
    advPanel.remove();
  }
  // "Character" is Illustrator jargon; this is just the object's Text properties.
  const charHeader = document.querySelector('#panel-type .panel-header span');
  if (charHeader) charHeader.textContent = 'Text';

  const fontSizeInput = document.getElementById('prop-font-size') as HTMLInputElement;
  const textContentInput = document.getElementById('prop-text-content') as HTMLTextAreaElement;
  const italicBtn = document.getElementById('prop-italic') as HTMLButtonElement;
  const lineHeightInput = document.getElementById('prop-line-height') as HTMLInputElement;
  const letterSpacingInput = document.getElementById('prop-letter-spacing') as HTMLInputElement;
  const textAlignGroup = document.getElementById('text-align') as HTMLElement;
  const textTransformSelect = document.getElementById('prop-text-transform') as HTMLSelectElement;
  const underlineBtn = document.getElementById('prop-underline') as HTMLButtonElement;
  const strikeBtn = document.getElementById('prop-strike') as HTMLButtonElement;
  const baselineShiftInput = document.getElementById('prop-baseline-shift') as HTMLInputElement;
  const pathOffsetInput = document.getElementById('prop-path-offset') as HTMLInputElement;
  // Text properties. These target the shape's <text> — or, for a MULTI-STROKE text
  // (wrapped as an `appearance` group), the hidden source <text> inside it — then
  // regenerate the wrapper's render-clones. The clones deep-clone the source, so every
  // attribute-based font prop propagates for free; text-transform is set on the outer
  // element instead and rides CSS inheritance into the clones.
  const applyTextProp = (
    write: (el: SVGTextElement, shape: ShapeData) => void,
    record: boolean,
  ): void => {
    const shapes = state.getSelectedShapes();
    let touched = false;
    for (const s of shapes) {
      const el = textTarget(s);
      if (!el) continue;
      touched = true;
      write(el, s);
      if (s.type === 'appearance') state.refreshAppearance(s.id); // rebuild multi-stroke render
    }
    if (!touched) return; // nothing selected → no-op (new text uses the fixed defaults)
    if (record) state.saveHistory();
    state.onChange_public();
  };
  // Multi-line text keeps its line spacing in each <tspan>'s dy (= font-size × line-height),
  // so a size- or line-height change must re-lay-out the tspans (single-line text has none).
  // AREA text re-WRAPS instead — any metric change moves the wrap points (#120).
  const relayoutTspans = (el: SVGTextElement): void => {
    if (isAreaText(el)) { reflowAreaText(el); return; }
    const tspans = el.querySelectorAll('tspan');
    if (!tspans.length) return;
    const fs = parseFloat(el.getAttribute('font-size') ?? '24') || 24;
    const lh = parseFloat(el.getAttribute('data-line-height') ?? '') || 1.2;
    tspans.forEach((t, i) => t.setAttribute('dy', i === 0 ? '0' : String(fs * lh)));
  };
  // Contents — the string itself. Empty is allowed (the shape stays selected so the
  // user can keep typing); a Mixed multi-selection is left alone until they type.
  const applyTextContent = (record: boolean): void => {
    if (textContentInput.placeholder === MIXED_HINT && textContentInput.value === '') return;
    applyTextProp((el) => writeTextLines(el, textContentInput.value.split('\n')), record);
  };
  // Releasing an imported run's pinned width belongs ONLY on edits that change its
  // advance width — family, size, weight, italic, letter-spacing (and content, handled
  // inside writeTextLines). Doing it for every text property meant a no-op click on
  // Underline or V-align silently reflowed an imported PDF run out of alignment.
  const applyFontFamilyValue = (family: string, record: boolean): void => applyTextProp((el, shape) => {
    releaseImportedTextWidth(el);
    el.setAttribute('font-family', family); if (shape.type === 'text') shape.style.fontFamily = family;
    relayoutTspans(el); // area text re-wraps: a family change moves the wrap points
  }, record);
  const applyFontSize = (record: boolean): void => {
    const v = parseFloat(fontSizeInput.value);
    if (!Number.isFinite(v)) return; // "Mixed"/empty field: don't clobber
    applyTextProp((el, shape) => {
      releaseImportedTextWidth(el);
      el.setAttribute('font-size', String(v)); if (shape.type === 'text') shape.style.fontSize = v;
      relayoutTspans(el);
    }, record);
  };
  const applyFontWeightValue = (w: number, record: boolean): void => {
    if (!Number.isFinite(w)) return;
    applyTextProp((el, shape) => {
      releaseImportedTextWidth(el);
      el.setAttribute('font-weight', String(w)); if (shape.type === 'text') shape.style.fontWeight = String(w);
      relayoutTspans(el);
    }, record);
  };
  const applyItalic = (record: boolean): void => {
    const it = italicBtn.classList.contains('active');
    applyTextProp((el, shape) => {
      releaseImportedTextWidth(el);
      el.setAttribute('font-style', it ? 'italic' : 'normal');
      if (shape.type === 'text') shape.style.fontStyle = it ? 'italic' : 'normal';
      relayoutTspans(el);
    }, record);
  };
  const applyLineHeight = (record: boolean): void => {
    const v = parseFloat(lineHeightInput.value);
    if (!Number.isFinite(v) || v <= 0) return; // "Mixed"/empty: don't clobber
    applyTextProp((el) => { el.setAttribute('data-line-height', String(v)); relayoutTspans(el); }, record);
  };
  const applyLetterSpacing = (record: boolean): void => {
    const v = parseFloat(letterSpacingInput.value);
    if (!Number.isFinite(v)) return;
    applyTextProp((el) => {
      releaseImportedTextWidth(el);
      if (v) el.setAttribute('letter-spacing', String(v)); else el.removeAttribute('letter-spacing');
      relayoutTspans(el);
    }, record);
  };
  const applyTextAnchor = (a: 'start' | 'middle' | 'end', record: boolean): void => applyTextProp((el) => {
    if (a === 'start') el.removeAttribute('text-anchor'); else el.setAttribute('text-anchor', a);
  }, record);
  // Vertical alignment within the box — area text only (point text has no box).
  const applyVAlign = (v: AreaVAlign, record: boolean): void => applyTextProp((el) => {
    if (isAreaText(el)) setAreaVAlign(el, v);
  }, record);
  // Case → text-transform, set on the OUTER element (the text, or the multi-stroke
  // wrapper) so it renders directly and, for a wrapper, CSS-inherits to the clones.
  const applyTextTransform = (record: boolean): void => {
    const v = textTransformSelect.value;
    applyTextProp((_el, shape) => {
      const hostEl = shape.element as unknown as SVGElement;
      if (v === 'none' || !v) hostEl.style.removeProperty('text-transform'); else hostEl.style.textTransform = v;
    }, record);
  };
  // OpenType features → font-feature-settings, on the outer element (renders directly;
  // CSS-inherits to a multi-stroke wrapper's clones, which strip inline style).
  const applyFontFeatures = (settings: string): void => {
    applyTextProp((_el, shape) => {
      const hostEl = shape.element as unknown as SVGElement;
      if (settings) hostEl.style.fontFeatureSettings = settings; else hostEl.style.removeProperty('font-feature-settings');
    }, true);
  };
  // Variable-font axes → font-variation-settings (width / optical size), on the outer
  // element (renders directly; CSS-inherits to a wrapper's clones). Weight is excluded
  // (it stays on font-weight via the specimen slider), so the two compose.
  const applyFontVariations = (settings: string): void => {
    applyTextProp((_el, shape) => {
      const hostEl = shape.element as unknown as SVGElement;
      if (settings) hostEl.style.fontVariationSettings = settings; else hostEl.style.removeProperty('font-variation-settings');
    }, true);
  };
  // Decoration → text-decoration (a real SVG presentation attribute). Underline + strike combine.
  const applyDecoration = (record: boolean): void => {
    const parts: string[] = [];
    if (underlineBtn.classList.contains('active')) parts.push('underline');
    if (strikeBtn.classList.contains('active')) parts.push('line-through');
    const val = parts.join(' ');
    applyTextProp((el) => { if (val) el.setAttribute('text-decoration', val); else el.removeAttribute('text-decoration'); }, record);
  };
  const applyBaselineShift = (record: boolean): void => {
    const v = parseFloat(baselineShiftInput.value);
    if (!Number.isFinite(v)) return;
    applyTextProp((el) => { if (v) el.setAttribute('baseline-shift', String(v)); else el.removeAttribute('baseline-shift'); }, record);
  };
  // Text-on-path: startOffset (% along the path) lives on the <textPath> child.
  const applyPathOffset = (record: boolean): void => {
    const v = parseFloat(pathOffsetInput.value);
    if (!Number.isFinite(v)) return;
    applyTextProp((el) => {
      const tp = el.querySelector('textPath');
      if (tp) { if (v) tp.setAttribute('startOffset', `${v}%`); else tp.removeAttribute('startOffset'); }
    }, record);
  };
  // Flip text to the other side of the path by REVERSING the baseline (SVG's textPath
  // side="right" is unsupported in Blink/WebKit). The text keeps its span, mirrored.
  const flipTextOnPath = (): void => {
    const shape = state.getSelectedShape();
    if (!shape) return;
    const textEl = textTarget(shape);
    const tp = textEl?.querySelector('textPath');
    if (!textEl || !tp) return;
    const pathId = (tp.getAttribute('href') || tp.getAttribute('xlink:href') || '').replace(/^#/, '');
    const pathEl = pathId ? (document.getElementById(pathId) as SVGGeometryElement | null) : null;
    const oldD = pathEl?.getAttribute('d');
    if (!pathEl || !oldD) return;
    flipTextSpan(tp, pathEl);
    pathEl.setAttribute('d', reversePathData(oldD));
    if (shape.type === 'appearance') state.refreshAppearance(shape.id);
    state.saveHistory();
    state.onChange_public();
  };

  const bindLive = bindLiveCommit;

  // Swap the plain weight <select> for the specimen weight slider at runtime (keeps
  // index.html untouched). onPick applies the weight — live while dragging, committed on release.
  const weightHost = document.createElement('div');
  document.getElementById('prop-font-weight')?.replaceWith(weightHost);
  setupWeightSlider(weightHost, (w, commit) => applyFontWeightValue(w, commit));
  italicBtn.addEventListener('click', () => {
    const on = italicBtn.classList.contains('indeterminate') ? true : !italicBtn.classList.contains('active');
    italicBtn.classList.remove('indeterminate');
    italicBtn.classList.toggle('active', on);
    applyItalic(true);
  });

  bindLive(fontSizeInput, () => applyFontSize(false), () => applyFontSize(true));
  // Contents: every keystroke live-updates the canvas; blur/change records history.
  // Enter inserts a newline (multi-line text); Escape just leaves the field.
  bindLive(textContentInput, () => applyTextContent(false), () => applyTextContent(true));
  textContentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); textContentInput.blur(); }
  });
  setupFontPicker(document.getElementById('font-family-picker')!, fontMenuGroups(), (family) => applyFontFamilyValue(family, true));
  bindLive(lineHeightInput, () => applyLineHeight(false), () => applyLineHeight(true));
  bindLive(letterSpacingInput, () => applyLetterSpacing(false), () => applyLetterSpacing(true));
  textAlignGroup.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = (btn.getAttribute('data-anchor') as 'start' | 'middle' | 'end') || 'start';
      textAlignGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyTextAnchor(a, true);
    });
  });
  const textVAlignGroup = document.getElementById('text-valign') as HTMLElement | null;
  textVAlignGroup?.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = (btn.getAttribute('data-valign') as AreaVAlign) || 'top';
      textVAlignGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyVAlign(v, true);
    });
  });
  textTransformSelect.addEventListener('change', () => applyTextTransform(true));
  const wireDecoBtn = (btn: HTMLButtonElement) => btn.addEventListener('click', () => {
    btn.classList.remove('indeterminate');
    btn.classList.toggle('active');
    applyDecoration(true);
  });
  wireDecoBtn(underlineBtn); wireDecoBtn(strikeBtn);
  bindLive(baselineShiftInput, () => applyBaselineShift(false), () => applyBaselineShift(true));
  bindLive(pathOffsetInput, () => applyPathOffset(false), () => applyPathOffset(true));
  // Flip control, appended to the path row at runtime (index.html is mid-refactor).
  const pathRowForFlip = document.getElementById('prop-path-row');
  if (pathRowForFlip && !document.getElementById('prop-path-flip')) {
    const field = document.createElement('div'); field.className = 'panel-field';
    const label = document.createElement('label'); label.textContent = 'Flip';
    const group = document.createElement('div'); group.className = 'text-style-group';
    const flipBtn = document.createElement('button');
    flipBtn.type = 'button'; flipBtn.className = 'text-style-btn'; flipBtn.id = 'prop-path-flip';
    flipBtn.title = 'Flip text to the other side of the path'; flipBtn.textContent = '⇅';
    group.appendChild(flipBtn); field.appendChild(label); field.appendChild(group);
    pathRowForFlip.appendChild(field);
    flipBtn.addEventListener('click', flipTextOnPath);
  }
  // OpenType feature chips, appended to the Text panel at runtime (font-inspected; the
  // row hides itself via CSS when the font offers no opt-in features).
  const charBodyForOt = document.querySelector('#panel-type .panel-body');
  if (charBodyForOt && !document.getElementById('prop-opentype')) {
    const otRow = document.createElement('div'); otRow.className = 'panel-row';
    const otField = document.createElement('div'); otField.className = 'panel-field full';
    const otLabel = document.createElement('label'); otLabel.textContent = 'OpenType';
    const otChips = document.createElement('div'); otChips.id = 'prop-opentype'; otChips.className = 'ot-chips';
    otField.appendChild(otLabel); otField.appendChild(otChips); otRow.appendChild(otField);
    charBodyForOt.appendChild(otRow);
    setupOpenType(otChips, (settings) => applyFontFeatures(settings));
  }
  // Variable-font axis sliders (width / optical size), appended at runtime; the row
  // hides itself when the font has no such axes.
  if (charBodyForOt && !document.getElementById('prop-axes')) {
    const axRow = document.createElement('div'); axRow.className = 'panel-row';
    const axField = document.createElement('div'); axField.className = 'panel-field full';
    const axHost = document.createElement('div'); axHost.id = 'prop-axes'; axHost.className = 'axis-list';
    axField.appendChild(axHost); axRow.appendChild(axField);
    charBodyForOt.appendChild(axRow);
    setupAxisSliders(axHost, (settings) => applyFontVariations(settings));
  }

}

export function resetTextProperties(): void {
  document.getElementById('prop-italic')!.classList.remove('indeterminate');
}

export function updateTextProperties(state: AppState): void {
  const fontSizeInput = document.getElementById('prop-font-size') as HTMLInputElement;
  const italicBtn = document.getElementById('prop-italic') as HTMLButtonElement;
  const lineHeightInput = document.getElementById('prop-line-height') as HTMLInputElement;
  const letterSpacingInput = document.getElementById('prop-letter-spacing') as HTMLInputElement;
  const textAlignGroup = document.getElementById('text-align') as HTMLElement;
  const textTransformSelect = document.getElementById('prop-text-transform') as HTMLSelectElement;
  const underlineBtn = document.getElementById('prop-underline') as HTMLButtonElement;
  const strikeBtn = document.getElementById('prop-strike') as HTMLButtonElement;
  const baselineShiftInput = document.getElementById('prop-baseline-shift') as HTMLInputElement;
  const pathOffsetInput = document.getElementById('prop-path-offset') as HTMLInputElement;
  const pathRow = document.getElementById('prop-path-row') as HTMLElement;
  const shapes = state.getSelectedShapes();

  // Character (text only) — the panel itself is shown by the inspector.
  // Text controls: shown for plain text AND multi-stroke text (read from the inner
  // source <text> via textTarget, so a wrapped text keeps its type settings).
  if (shapes.length > 0 && shapes.every(isTextShape)) {
    const te = (s: ShapeData) => textTarget(s)!; // gate guarantees non-null
    // Contents — never rewrite the field mid-typing (each keystroke live-applies,
    // which re-renders this panel and would clobber the entry).
    const contentField = document.getElementById('prop-text-content') as HTMLTextAreaElement | null;
    if (contentField && document.activeElement !== contentField) {
      const content = common(shapes, s => readTextLines(te(s)).join('\n'));
      if (content === MIXED || content === undefined) { contentField.value = ''; contentField.placeholder = MIXED_HINT; }
      else { contentField.value = content; contentField.placeholder = 'Type text…'; }
    }
    const fam = common(shapes, s => te(s).getAttribute('font-family') ?? 'Arial');
    setFontPickerValue(fam === MIXED || fam === undefined ? '' : fam);
    setNumField(fontSizeInput, common(shapes, s => parseFloat(te(s).getAttribute('font-size') ?? '24') || 24));
    setToggle(italicBtn, common(shapes, s => te(s).getAttribute('font-style') === 'italic'));
    // Weight slider: specimen "A" per real weight of the family; thumb on the common
    // weight, or Mixed (no thumb) when the selection's weights differ.
    const famName = fam === MIXED || fam === undefined ? 'Arial' : fam;
    const cwRaw = common(shapes, s => normalizeWeight(te(s).getAttribute('font-weight')));
    const cw: number | null = cwRaw === MIXED || cwRaw == null ? null : cwRaw;
    setWeightSlider(famName, cw);
    setNumField(lineHeightInput, common(shapes, s => {
      const lh = parseFloat(te(s).getAttribute('data-line-height') ?? '');
      return Number.isFinite(lh) && lh > 0 ? lh : 1.2;
    }));
    setNumField(letterSpacingInput, common(shapes, s => parseFloat(te(s).getAttribute('letter-spacing') ?? '0') || 0));
    const anchor = common(shapes, s => te(s).getAttribute('text-anchor') || 'start');
    textAlignGroup.querySelectorAll('button').forEach(b =>
      b.classList.toggle('active', anchor !== MIXED && b.getAttribute('data-anchor') === anchor));
    // Vertical align — only for FIXED-HEIGHT area text (a box to align within);
    // hidden for point text and auto-height boxes. Reflects the common value.
    const valignRow = document.getElementById('prop-valign-row');
    const isFixedArea = (s: ShapeData) => { const el = te(s); return isAreaText(el) && el.hasAttribute('data-area-h'); };
    const showVAlign = shapes.every(isFixedArea); // shapes is non-empty here
    if (valignRow) valignRow.style.display = showVAlign ? '' : 'none';
    if (showVAlign) {
      const va = common(shapes, s => areaVAlign(te(s)));
      document.querySelectorAll('#text-valign button').forEach(b =>
        b.classList.toggle('active', va !== MIXED && b.getAttribute('data-valign') === va));
    }
    // Case is on the outer element (text or wrapper), where applyTextTransform set it.
    const tt = common(shapes, s => (s.element as unknown as SVGElement).style.textTransform || 'none');
    textTransformSelect.value = tt === MIXED || !tt ? 'none' : tt;
    // OpenType chips: rebuild for the family, reflecting the current font-feature-settings.
    const feat = common(shapes, s => (s.element as unknown as SVGElement).style.fontFeatureSettings || '');
    void setOpenType(famName, feat === MIXED || feat === undefined ? '' : feat);
    // Variable-font axis sliders (width / optical size) for the family.
    const varr = common(shapes, s => (s.element as unknown as SVGElement).style.fontVariationSettings || '');
    setAxisSliders(famName, varr === MIXED || varr === undefined ? '' : varr);
    setToggle(underlineBtn, common(shapes, s => (te(s).getAttribute('text-decoration') || '').includes('underline')));
    setToggle(strikeBtn, common(shapes, s => (te(s).getAttribute('text-decoration') || '').includes('line-through')));
    setNumField(baselineShiftInput, common(shapes, s => parseFloat(te(s).getAttribute('baseline-shift') ?? '0') || 0));
    // Path controls: only when every selected text is flowed on a path (<textPath>).
    const onPath = shapes.every(s => !!te(s).querySelector('textPath'));
    pathRow.style.display = onPath ? '' : 'none';
    if (onPath) {
      setNumField(pathOffsetInput, common(shapes, s =>
        parseFloat(te(s).querySelector('textPath')?.getAttribute('startOffset') ?? '0') || 0));
      const flipBtnEl = document.getElementById('prop-path-flip');
      if (flipBtnEl) {
        const flipped = common(shapes, s => te(s).querySelector('textPath')?.getAttribute('data-flip') === '1');
        flipBtnEl.classList.toggle('active', flipped === true);
      }
    }
  }

}
