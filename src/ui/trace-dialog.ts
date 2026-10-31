// ---------------------------------------------------------------------------
// Image Trace dialog — choose how a raster image becomes paths, and SEE it.
//
// The preview is the point. Tracing is a guessing game otherwise: the same photo
// is 6 paths or 3,000 depending on colour count, and nothing on a settings panel
// tells you which you're about to get. So every change re-traces at thumbnail
// resolution and reports the path count, and the Trace button commits the same
// settings at full resolution.
//
// Built on openModal directly rather than dialogs.ts' formModal (which is private
// and synchronous) because this dialog owns async work, but it reuses the same
// .dlg-* classes so it looks like every other dialog.
// ---------------------------------------------------------------------------

import { openModal } from './modal';
import { sliderField } from './slider-field';
import {
  DEFAULT_TRACE_OPTIONS, PREVIEW_TRACE_PX, TraceError, traceShape,
  type TraceOptions, type TraceResult,
} from '../core/image-trace';

const SVG = 'http://www.w3.org/2000/svg';

export interface TraceDialogResult {
  options: TraceOptions;
  /** Trace the image and delete it, or keep it underneath. */
  replace: boolean;
}

/** A path count past which the result stops being editable artwork and starts
 *  being a liability — the dialog says so rather than letting it land silently. */
const BUSY_PATHS = 1200;

export function openTraceDialog(el: SVGElement): Promise<TraceDialogResult | null> {
  return new Promise((resolve) => {
    let done = false;
    const opts: TraceOptions = { ...DEFAULT_TRACE_OPTIONS };
    let replace = true;

    const modal = openModal({
      id: 'trace-dialog',
      ariaLabel: 'Trace Image',
      dialogClass: 'dlg dlg-trace',
      closeButton: false,
      onClose: () => finish(null),
    });
    if (!modal) { resolve(null); return; }

    const finish = (v: TraceDialogResult | null): void => {
      if (done) return;
      done = true;
      modal.close();
      resolve(v);
    };

    // ---- head ----
    const head = document.createElement('div');
    head.className = 'dlg-head';
    const h = document.createElement('h2');
    h.className = 'dlg-title';
    h.textContent = 'Trace Image';
    const msg = document.createElement('p');
    msg.className = 'dlg-msg';
    msg.textContent = 'Turn this picture into editable shapes. Flat artwork — logos, line art, screenshots — traces best.';
    head.append(h, msg);
    modal.dialog.appendChild(head);

    const body = document.createElement('div');
    body.className = 'dlg-body dlg-trace-body';
    modal.dialog.appendChild(body);

    // ---- preview ----
    const preview = document.createElement('div');
    preview.className = 'dlg-trace-preview';
    const previewInner = document.createElement('div');
    previewInner.className = 'dlg-trace-canvas';
    const status = document.createElement('div');
    status.className = 'dlg-trace-status';
    status.textContent = 'Tracing…';
    preview.append(previewInner, status);

    const controls = document.createElement('div');
    controls.className = 'dlg-trace-controls';
    body.append(preview, controls);

    // ---- controls ----
    const field = (labelText: string): HTMLElement => {
      const wrap = document.createElement('div');
      wrap.className = 'dlg-field';
      const l = document.createElement('label');
      l.className = 'dlg-label';
      l.textContent = labelText;
      wrap.appendChild(l);
      controls.appendChild(wrap);
      return wrap;
    };

    const modeWrap = field('Style');
    const seg = document.createElement('div');
    seg.className = 'dlg-seg';
    const MODES: { val: TraceOptions['mode']; label: string; hint: string }[] = [
      { val: 'color', label: 'Colour', hint: 'Keeps the picture’s colours' },
      { val: 'lineart', label: 'Line art', hint: 'Two tones, black on white' },
      { val: 'silhouette', label: 'Silhouette', hint: 'One solid shape' },
    ];
    for (const m of MODES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dlg-seg-btn' + (m.val === opts.mode ? ' active' : '');
      b.innerHTML = `<span class="dlg-seg-label">${m.label}</span><span class="dlg-seg-hint">${m.hint}</span>`;
      b.addEventListener('click', () => {
        opts.mode = m.val;
        seg.querySelectorAll('.dlg-seg-btn').forEach((x) => x.classList.toggle('active', x === b));
        syncVisibility();
        schedule();
      });
      seg.appendChild(b);
    }
    modeWrap.appendChild(seg);

    /** A labelled range + its value field, and an optional word for the value. */
    const slider = (
      labelText: string, min: number, max: number, step: number,
      get: () => number, set: (v: number) => void, hint?: (v: number) => string,
    ): HTMLElement => {
      const wrap = field(labelText);
      const row = document.createElement('div');
      row.className = 'dlg-trace-slider';
      const input = document.createElement('input');
      input.type = 'range';
      input.title = labelText;
      input.min = String(min); input.max = String(max); input.step = String(step);
      input.value = String(get());
      const out = document.createElement('span');
      out.className = 'dlg-trace-value';
      out.textContent = hint?.(get()) ?? '';
      input.addEventListener('input', () => {
        set(parseFloat(input.value));
        out.textContent = hint?.(get()) ?? '';
        schedule();
      });
      row.append(input, sliderField(input), out);
      wrap.appendChild(row);
      return wrap;
    };

    const colorsField = slider('Colours', 2, 24, 1,
      () => opts.colors, (v) => { opts.colors = v; });
    slider('Detail', 0, 100, 1,
      () => opts.detail, (v) => { opts.detail = v; },
      (v) => v < 25 ? 'Sharp' : v < 60 ? 'Balanced' : 'Smooth');
    slider('Ignore specks', 0, 80, 1,
      () => opts.despeckle, (v) => { opts.despeckle = v; },
      (v) => v === 0 ? 'Keep all' : '');

    const repWrap = document.createElement('label');
    repWrap.className = 'dlg-trace-replace';
    const rep = document.createElement('input');
    rep.type = 'checkbox';
    rep.className = 'dlg-check';   // .dlg-check styles the BOX, not the row
    rep.checked = replace;
    rep.addEventListener('change', () => { replace = rep.checked; });
    const repText = document.createElement('span');
    repText.textContent = 'Replace the image with the traced shapes';
    repWrap.append(rep, repText);
    controls.appendChild(repWrap);

    const syncVisibility = (): void => {
      colorsField.style.display = opts.mode === 'color' ? '' : 'none';
    };
    syncVisibility();

    // ---- foot ----
    const foot = document.createElement('div');
    foot.className = 'dlg-foot';
    const cancel = document.createElement('button');
    cancel.className = 'dlg-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => finish(null));
    const ok = document.createElement('button');
    ok.className = 'dlg-btn dlg-btn-primary';
    ok.textContent = 'Trace';
    ok.addEventListener('click', () => finish({ options: { ...opts }, replace }));
    foot.append(cancel, ok);
    modal.dialog.appendChild(foot);

    // ---- live preview ----
    // Re-traces are debounced and generation-stamped: dragging a slider fires many
    // of them and they finish out of order, so a stale result must never paint
    // over a newer one.
    let timer: number | undefined;
    let generation = 0;

    const paint = (r: TraceResult): void => {
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('viewBox', `0 0 ${r.pixelW} ${r.pixelH}`);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      for (const p of r.paths) {
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', p.d);
        path.setAttribute('fill', p.fill);
        svg.appendChild(path);
      }
      previewInner.replaceChildren(svg);
      const busy = r.paths.length >= BUSY_PATHS;
      status.classList.toggle('is-warn', busy);
      status.textContent = busy
        ? `${r.paths.length} shapes — heavy. Fewer colours, or more “ignore specks”, will simplify it.`
        : `${r.paths.length} shape${r.paths.length === 1 ? '' : 's'}`;
    };

    const run = async (): Promise<void> => {
      const gen = ++generation;
      status.classList.remove('is-warn');
      status.textContent = 'Tracing…';
      try {
        const r = await traceShape(el, opts, PREVIEW_TRACE_PX);
        if (gen !== generation || done) return;   // superseded by a newer run
        paint(r);
      } catch (err) {
        if (gen !== generation || done) return;
        previewInner.replaceChildren();
        status.classList.add('is-warn');
        status.textContent = err instanceof TraceError ? err.message : 'Couldn’t trace that image.';
        ok.disabled = true;
      }
    };

    const schedule = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void run(); }, 140);
    };

    void run();
  });
}
