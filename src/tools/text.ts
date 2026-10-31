import { BaseTool } from './base';
import { createMarqueeRect } from '../ui/overlay-chrome';
import type { Point } from '../core/types';
import { TEXT_LINE_HEIGHT, textLineHeight, readTextLines, writeTextLines } from '../core/text-lines';
import { isAreaText } from '../core/area-text';
import { refreshToolHint } from '../ui/tool-hint';

// Shared 2D context for font-metric measurement (see baselineOffsetPx).
let metricsCtx: CanvasRenderingContext2D | null = null;

/** Real ascent/descent of a font at `px`, via canvas measureText. Falls back to
 *  the common 80/20 split if the browser lacks fontBoundingBox metrics. */
function fontMetrics(px: number, family: string, weight: string, italic: boolean): { asc: number; desc: number } {
  metricsCtx ??= document.createElement('canvas').getContext('2d');
  if (metricsCtx) {
    metricsCtx.font = `${italic ? 'italic ' : ''}${weight} ${px}px ${family}`;
    const m = metricsCtx.measureText('Mg');
    if (m.fontBoundingBoxAscent != null) {
      return { asc: m.fontBoundingBoxAscent, desc: m.fontBoundingBoxDescent ?? px * 0.2 };
    }
  }
  return { asc: px * 0.8, desc: px * 0.2 };
}

/** Distance from a textarea's content top to its FIRST text baseline: CSS centers
 *  the font's ascent+descent box inside the line box (half-leading above and below).
 *  Getting this exact is what keeps the editor's glyphs pixel-aligned with the
 *  rendered SVG text (whose y attribute IS the first baseline). */
function baselineOffsetPx(px: number, lineHeight: number, family: string, weight: string, italic: boolean): number {
  const { asc, desc } = fontMetrics(px, family, weight, italic);
  return (lineHeight * px - (asc + desc)) / 2 + asc;
}

/** Layer name derived from the text's content: the first non-empty line,
 *  trimmed to 24 chars ("MOONLAKE", never "Type 23" — #225). */
function textLayerName(lines: string[]): string {
  const first = lines.find(l => l.trim().length > 0)?.trim() ?? '';
  return first ? (first.length > 24 ? first.slice(0, 24) + '…' : first) : 'Text';
}

/**
 * Type tool with an in-canvas editor: click to place a caret (or click an
 * existing text to edit it), type — including multiple lines with Enter — then
 * click away / Esc to commit. Multi-line text is rendered as a <text> with one
 * <tspan> per line (dy line spacing). Replaces the old single-line prompt().
 */
export class TextTool extends BaseTool {
  private editor: HTMLTextAreaElement | null = null;
  private editingEl: SVGTextElement | null = null; // non-null when editing existing text
  private anchor: Point = { x: 0, y: 0 };           // SVG-space top-left of the text block
  private baselineSvg = 0;                          // editor first-baseline offset in SVG units
  private returnToSelect = false;                   // hop back to Select after a hand-off edit
  private anchorScreenX = 0;                         // screen x of the text-anchor point
  private textAnchor: 'start' | 'middle' | 'end' = 'start';
  // Drag-to-create AREA text (#120): mousedown on empty space arms a possible box
  // drag; a real drag draws a marquee and commits a fixed-width wrapping text box.
  private pendingStart: Point | null = null;
  private pendingDragged = false;
  private areaBox: { w: number; h: number } | null = null; // pending box for createText
  private editorFixedWidthPx: number | null = null;         // fixed-width editor mode
  private marqueeRect: SVGRectElement | null = null;
  name = 'text';

  /** Entered via a Select-tool double-click on text: edit that element immediately,
   *  then return to the Select tool when the edit commits (see AppState.textEditTarget). */
  activate(): void {
    const id = this.state.textEditTarget;
    if (!id) return;
    this.state.textEditTarget = null;
    const el = this.state.findShapeById(id)?.element as SVGTextElement | undefined;
    if (el && el.tagName.toLowerCase() === 'text' && el.id) {
      this.returnToSelect = true;
      this.editExisting(el);
    }
  }

  onMouseDown(pt: Point, e: MouseEvent): void {
    if (this.editor) { this.commit(); return; } // a click elsewhere commits the open editor
    e.preventDefault(); // don't let the mousedown steal focus back from the editor
    const textEl = (e.target as Element).closest?.('text') as SVGTextElement | null;
    if (textEl && textEl.id) { this.editExisting(textEl); return; }
    // Empty space: arm click-vs-drag. A click places POINT text (on mouseup);
    // a drag defines an AREA text box that wraps at its width (#120).
    this.pendingStart = { ...pt };
    this.pendingDragged = false;
  }

  onDoubleClick(_pt: Point, e: MouseEvent): void {
    e.preventDefault();
    const textEl = (e.target as Element).closest?.('text') as SVGTextElement | null;
    if (textEl && textEl.id) this.editExisting(textEl);
  }

  onMouseMove(pt: Point): void {
    if (!this.pendingStart) return;
    const t = 4 / this.canvas.getZoom();
    if (!this.pendingDragged &&
        (Math.abs(pt.x - this.pendingStart.x) > t || Math.abs(pt.y - this.pendingStart.y) > t)) {
      this.pendingDragged = true;
      this.createMarquee();
    }
    if (this.pendingDragged) this.updateMarquee(pt);
  }

  onMouseUp(pt: Point): void {
    if (!this.pendingStart) return;
    const start = this.pendingStart;
    const dragged = this.pendingDragged;
    this.pendingStart = null;
    this.pendingDragged = false;
    this.removeMarquee();
    if (dragged) {
      const x = Math.min(start.x, pt.x), y = Math.min(start.y, pt.y);
      const w = Math.abs(pt.x - start.x), h = Math.abs(pt.y - start.y);
      if (w >= 20) { // too small a box reads as a slip — fall back to point text
        this.areaBox = { w, h };
        this.openEditor({ x, y }, null, '');
        return;
      }
    }
    this.openEditor(start, null, '');
  }

  deactivate(): void {
    if (this.editor) this.commit();
    this.pendingStart = null;
    this.pendingDragged = false;
    this.removeMarquee();
  }

  // ---- Area-box marquee (drawn while dragging out a text box) ----

  private createMarquee(): void {
    const layer = this.svgCanvas.querySelector('#selection-layer');
    if (!layer) return;
    const rect = createMarqueeRect(); // shared constant-size chrome — see ui/overlay-chrome
    layer.appendChild(rect);
    this.marqueeRect = rect;
  }

  private updateMarquee(pt: Point): void {
    if (!this.marqueeRect || !this.pendingStart) return;
    const s = this.pendingStart;
    this.marqueeRect.setAttribute('x', String(Math.min(pt.x, s.x)));
    this.marqueeRect.setAttribute('y', String(Math.min(pt.y, s.y)));
    this.marqueeRect.setAttribute('width', String(Math.abs(pt.x - s.x)));
    this.marqueeRect.setAttribute('height', String(Math.abs(pt.y - s.y)));
  }

  private removeMarquee(): void {
    this.marqueeRect?.remove();
    this.marqueeRect = null;
  }

  // ---- Editing ----

  private editExisting(el: SVGTextElement): void {
    const lines = readTextLines(el);
    let anchor: Point;
    if (el.querySelector('textPath')) {
      // Text-on-a-path has no x/y — anchor the editor at its rendered bbox.
      let bb: DOMRect; try { bb = el.getBBox(); } catch { bb = new DOMRect(); }
      anchor = { x: bb.x, y: bb.y };
    } else {
      // The element's own (x, y) — its FIRST-LINE BASELINE. openEditor maps it
      // through the real CTM and the editor's own baseline metrics; guessing the
      // top edge here (the old y − 0.85·fs fudge) made the overlay text sit
      // visibly lower than the rendered text during the edit.
      anchor = { x: parseFloat(el.getAttribute('x') ?? '0'), y: parseFloat(el.getAttribute('y') ?? '0') };
    }
    // Keep the live text VISIBLE during the edit (Figma-style): its fill AND stroke
    // stay on screen while you type. The overlay textarea is transparent (caret only)
    // and the live text is re-rendered on each keystroke to match — so what you edit
    // looks exactly like the result, stroke and all. (Old behaviour hid the text and
    // showed a plain-fill textarea, so the stroke vanished mid-edit — issue #170.)
    this.openEditor(anchor, el, lines.join('\n'));
  }

  private openEditor(topLeft: Point, existing: SVGTextElement | null, value: string): void {
    this.editingEl = existing;
    this.anchor = topLeft;

    const fs = existing
      ? parseFloat(existing.getAttribute('font-size') ?? '24')
      : (this.state.defaultStyle.fontSize ?? 24);
    const family = existing?.getAttribute('font-family') ?? this.state.defaultStyle.fontFamily ?? 'Arial';
    const weight = existing?.getAttribute('font-weight') ?? this.state.defaultStyle.fontWeight ?? 'normal';
    const italic = (existing?.getAttribute('font-style') ?? this.state.defaultStyle.fontStyle) === 'italic';
    const color = existing?.getAttribute('fill') ?? (this.state.fillNone ? '#000' : this.state.defaultStyle.fill);
    // When editing EXISTING text we keep the real (styled, stroked) glyphs visible and
    // live-update them as you type, so the overlay's own text must be invisible — just
    // its caret. New text has nothing underneath, so it stays visible in the overlay.
    // A caret needs a real colour; fall back for outline-only ('none' fill) text.
    const caretColor = color && color !== 'none' ? color : '#2d7ff9';
    const overlayColor = existing ? 'transparent' : color;
    const lh = existing ? textLineHeight(existing) : TEXT_LINE_HEIGHT;
    // Mirror the rendered typography so the editor looks like the result (WYSIWYG).
    const ls = existing ? (parseFloat(existing.getAttribute('letter-spacing') ?? '0') || 0) : 0;
    const anchorAttr = ((existing?.getAttribute('text-anchor')) as 'start' | 'middle' | 'end') || 'start';
    const transform = existing ? ((existing as SVGTextElement).style.textTransform || 'none') : 'none';
    const decoration = existing?.getAttribute('text-decoration') || 'none';
    const align = anchorAttr === 'middle' ? 'center' : anchorAttr === 'end' ? 'right' : 'left';

    const zoom = this.canvas.getZoom();
    // First-baseline offset inside the textarea (+1px for its top border), from the
    // font's REAL metrics — this is what pins the overlay glyphs onto the rendered ones.
    const baseline = baselineOffsetPx(fs * zoom, lh, family, weight, italic) + 1;
    let scr: Point;
    if (existing && !existing.querySelector('textPath')) {
      // topLeft is the baseline point in the element's own coords; the screen CTM
      // honours element/group/frame transforms that raw viewBox math would miss.
      const ctm = existing.getScreenCTM();
      const p = ctm ? new DOMPoint(topLeft.x, topLeft.y).matrixTransform(ctm) : this.svgToScreen(topLeft.x, topLeft.y);
      scr = { x: p.x, y: p.y - baseline };
    } else {
      scr = this.svgToScreen(topLeft.x, topLeft.y);
    }
    this.anchorScreenX = scr.x;
    this.textAnchor = anchorAttr;
    // Where the editor's first baseline sits below its top edge, in SVG units —
    // commit writes NEW text's y from this so the glyphs don't jump on close.
    this.baselineSvg = baseline / zoom;

    // Area text edits in a FIXED-WIDTH wrapping editor matching the box, so the
    // overlay wraps where the committed text will (same font metrics both sides).
    const areaW = existing && isAreaText(existing)
      ? parseFloat(existing.getAttribute('data-area-w') ?? '0') || null
      : (this.areaBox?.w ?? null);
    this.editorFixedWidthPx = areaW ? areaW * zoom : null;

    const ta = document.createElement('textarea');
    ta.value = value;
    ta.spellcheck = false;
    ta.rows = 1;
    ta.style.cssText = `position:fixed; left:${scr.x}px; top:${scr.y}px; margin:0; padding:0;
      border:1px dashed #2d7ff9; outline:none; background:transparent; resize:none; overflow:hidden;
      white-space:${areaW ? 'pre-wrap' : 'pre'}; line-height:${lh}; z-index:10000; text-align:${align};
      ${areaW ? `width:${this.editorFixedWidthPx}px; overflow-wrap:break-word; word-break:break-word;` : ''}
      letter-spacing:${ls * zoom}px; text-transform:${transform}; text-decoration:${decoration};
      font-size:${fs * zoom}px; font-family:${family}; font-weight:${weight};
      font-style:${italic ? 'italic' : 'normal'}; color:${overlayColor}; caret-color:${caretColor};`;
    ta.setAttribute('data-text-editor', ''); // the tool-hint strip reads this: "Esc · done"
    document.body.appendChild(ta);
    this.editor = ta;
    this.autosize();
    ta.focus();
    refreshToolHint();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    ta.addEventListener('input', () => { this.autosize(); this.syncLiveText(); });
    ta.addEventListener('blur', () => this.commit());
    ta.addEventListener('keydown', (ev) => {
      // Escape COMMITS (matching the tool doc and Figma) — it used to silently
      // discard everything typed into a new text object (#217).
      if (ev.key === 'Escape') { ev.preventDefault(); ta.blur(); }
      // Enter inserts a newline (textarea default); ⌘/Ctrl+Enter commits.
      else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ta.blur(); }
    });
  }

  private commit(): void {
    const ta = this.editor;
    if (!ta) return;
    this.editor = null;
    const back = this.returnToSelect;
    this.returnToSelect = false;
    const created = this.doCommit(ta);
    // Hop back to Select after CREATING a text object — matching every other draw
    // tool (Figma-style, #174) — and after a double-click hand-off edit. Re-entrant-
    // safe: switching tools calls deactivate()→commit(), but editor is now null so
    // that inner commit is a no-op.
    if (back || created) this.state.requestTool?.('select');
  }

  /** @returns true when a NEW text object was created (the caller then returns to
   *  Select). Editing/removing existing text or an empty caret return false. */
  private doCommit(ta: HTMLTextAreaElement): boolean {
    const raw = ta.value.replace(/\n+$/,''); // trim trailing blank lines
    const lines = raw.length ? raw.split('\n') : [];
    ta.remove();
    refreshToolHint();

    const existing = this.editingEl;
    this.editingEl = null;

    if (existing) {
      if (lines.length === 0) { this.state.removeShape(existing.id); return false; }
      existing.style.removeProperty('visibility');
      writeTextLines(existing, lines);
      // A still-auto-named text layer follows its content ("MOONLAKE", not
      // "Type 23" — #225); a manual rename cleared the flag and sticks.
      if (existing.hasAttribute('data-name-auto')) {
        const n = textLayerName(lines);
        existing.setAttribute('data-name', n);
        const sh = this.state.findShapeById(existing.id);
        if (sh) sh.name = n;
      }
      this.state.saveHistory();
      this.state.onChange_public();
      return false;
    }

    if (lines.length === 0) { this.areaBox = null; return false; } // nothing typed → no shape
    this.createText(lines);
    return true;
  }

  private createText(lines: string[]): void {
    const s = this.state;
    const fs = s.defaultStyle.fontSize ?? 24;
    const el = document.createElementNS(this.NS, 'text') as SVGTextElement;
    const id = s.nextId();
    el.id = id;
    el.setAttribute('x', String(this.anchor.x));
    el.setAttribute('y', String(this.anchor.y + (this.baselineSvg || fs * 0.85))); // first-line baseline, matching the editor overlay
    el.setAttribute('font-size', String(fs));
    el.setAttribute('font-family', s.defaultStyle.fontFamily ?? 'Arial');
    el.setAttribute('font-weight', s.defaultStyle.fontWeight ?? 'normal');
    el.setAttribute('font-style', s.defaultStyle.fontStyle ?? 'normal');
    el.setAttribute('fill', s.fillNone ? 'none' : s.defaultStyle.fill);
    // Text is fill-only by default — a stroke outlines the glyphs, which reads as a
    // mistake. The user can still add a stroke afterward via the Appearance panel.
    if (s.defaultStyle.opacity !== 1) el.setAttribute('opacity', String(s.defaultStyle.opacity));
    // A dragged-out box makes this AREA text: set the box BEFORE writing the
    // content so writeTextLines routes through the wrapping engine (#120).
    if (this.areaBox) {
      el.setAttribute('data-area-w', String(Math.max(1, this.areaBox.w)));
      if (this.areaBox.h >= 20) el.setAttribute('data-area-h', String(this.areaBox.h));
      this.areaBox = null;
    }
    writeTextLines(el, lines); // reads x / font-size off the attributes set above
    // Name the layer by its CONTENT (Figma-style), not an internal counter
    // ("MOONLAKE", not "Type 23" — #225). data-name-auto marks it as derived so
    // later edits keep it fresh until the user renames manually.
    const name = textLayerName(lines);
    el.setAttribute('data-name', name);
    el.setAttribute('data-name-auto', '1');
    s.addShape({
      id, type: 'text', element: el, name,
      style: { ...s.defaultStyle, fill: s.fillNone ? 'none' : s.defaultStyle.fill, stroke: 'none', strokeWidth: 0 },
      visible: true, locked: false,
    });
  }

  /** Re-render the text being edited on each keystroke so the live (styled, stroked)
   *  glyphs track the transparent overlay. Existing-text edits only — new text has no
   *  element yet. No history here; doCommit records the single undo step on close. */
  private syncLiveText(): void {
    const el = this.editingEl;
    const ta = this.editor;
    if (!el || !ta) return;
    const raw = ta.value.replace(/\n+$/, '');
    writeTextLines(el, raw.length ? raw.split('\n') : ['']);
  }

  private autosize(): void {
    const ta = this.editor;
    if (!ta) return;
    if (this.editorFixedWidthPx != null) {
      // Area text: the width is the box — only the height follows the content.
      ta.style.height = '0';
      ta.style.height = `${ta.scrollHeight}px`;
      return;
    }
    ta.style.width = '0'; ta.style.height = '0';
    const w = ta.scrollWidth + 4;
    ta.style.width = `${w}px`;
    ta.style.height = `${ta.scrollHeight}px`;
    // Center/right-anchored text grows from its anchor point, not its left edge — keep
    // the anchor fixed as the box widens so the editor tracks the rendered position.
    if (this.textAnchor === 'middle') ta.style.left = `${Math.round(this.anchorScreenX - w / 2)}px`;
    else if (this.textAnchor === 'end') ta.style.left = `${Math.round(this.anchorScreenX - w)}px`;
  }

  private svgToScreen(x: number, y: number): Point {
    const rect = this.svgCanvas.getBoundingClientRect();
    const vb = this.canvas.getViewBox();
    const zoom = this.canvas.getZoom();
    return { x: rect.left + (x - vb.x) * zoom, y: rect.top + (y - vb.y) * zoom };
  }
}
