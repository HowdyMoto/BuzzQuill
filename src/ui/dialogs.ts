// ---------------------------------------------------------------------------
// Elegant promise-based dialogs — replacements for window.prompt / .confirm.
//
// Built on the shared Modal primitive (ui/modal.ts). Each returns a Promise that
// resolves when the user confirms, cancels, presses Escape, or clicks the
// backdrop. Styling lives in the `.dlg-*` classes in style.css. These stack over
// other modals (e.g. the import dialog), so each uses a unique overlay id.
// ---------------------------------------------------------------------------

import { openModal, type ModalHandle } from './modal';

let seq = 0;
const uid = (): string => `dlg-${++seq}`;

interface BaseOpts {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

/** Shared surface: title, optional message, a body you fill, and a button row.
 *  Resolves once — via confirm(), cancel, Escape, or backdrop. */
function formModal<T>(
  opts: BaseOpts,
  build: (body: HTMLElement, submit: () => void) => void,
  collect: () => T,
): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    let modal: ModalHandle | null = null;
    const finish = (value: T | null) => {
      if (done) return;
      done = true;
      modal?.close();               // triggers onClose → finish(null), guarded by `done`
      resolve(value);
    };

    modal = openModal({
      id: uid(),
      ariaLabel: opts.title,
      dialogClass: 'dlg',
      closeButton: false,
      onClose: () => finish(null),
    });
    if (!modal) { resolve(null); return; }

    const submit = () => finish(collect());

    const head = document.createElement('div');
    head.className = 'dlg-head';
    const h = document.createElement('h2');
    h.className = 'dlg-title';
    h.textContent = opts.title;
    head.appendChild(h);
    if (opts.message) {
      const m = document.createElement('p');
      m.className = 'dlg-msg';
      m.textContent = opts.message;
      head.appendChild(m);
    }
    modal.dialog.appendChild(head);

    const body = document.createElement('div');
    body.className = 'dlg-body';
    modal.dialog.appendChild(body);
    build(body, submit);

    const foot = document.createElement('div');
    foot.className = 'dlg-foot';
    const cancel = document.createElement('button');
    cancel.className = 'dlg-btn';
    cancel.textContent = opts.cancelText ?? 'Cancel';
    cancel.addEventListener('click', () => finish(null));
    const ok = document.createElement('button');
    ok.className = 'dlg-btn dlg-btn-primary' + (opts.danger ? ' dlg-btn-danger' : '');
    ok.textContent = opts.confirmText ?? 'OK';
    ok.addEventListener('click', submit);
    foot.append(cancel, ok);
    modal.dialog.appendChild(foot);
  });
}

/** A styled confirm(). Resolves true only if the user clicks the confirm button. */
export function confirmDialog(opts: BaseOpts): Promise<boolean> {
  return formModal<boolean>(
    { confirmText: 'Confirm', ...opts },
    () => { /* message-only body */ },
    () => true,
  ).then((v) => v === true);
}

interface PromptOpts extends BaseOpts {
  label?: string;
  value?: string;
  placeholder?: string;
  /** Suggestions offered via a <datalist> (e.g. existing categories). */
  suggestions?: string[];
}

/** A styled prompt(). Resolves the trimmed string, or null if cancelled. */
export function promptDialog(opts: PromptOpts): Promise<string | null> {
  let input: HTMLInputElement;
  return formModal<string>(
    { confirmText: 'Save', ...opts },
    (body, submit) => {
      if (opts.label) {
        const l = document.createElement('label');
        l.className = 'dlg-label';
        l.textContent = opts.label;
        body.appendChild(l);
      }
      input = document.createElement('input');
      input.className = 'dlg-input';
      input.type = 'text';
      input.value = opts.value ?? '';
      if (opts.placeholder) input.placeholder = opts.placeholder;
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (opts.suggestions?.length) {
        const dlId = uid();
        const dl = document.createElement('datalist');
        dl.id = dlId;
        for (const s of opts.suggestions) { const o = document.createElement('option'); o.value = s; dl.appendChild(o); }
        body.appendChild(dl);
        input.setAttribute('list', dlId);
      }
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      body.appendChild(input);
      queueMicrotask(() => { input.focus(); input.select(); });
    },
    () => input.value.trim(),
  );
}

/** One editable property of a style, rendered by the live Style panel. */
export interface EditField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'color' | 'checkbox' | 'select';
  value: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[]; // for 'select'
  /** Show this field only while another field holds a given value — e.g. the
   *  shadow parameters only matter when the shadow checkbox is ticked. */
  showWhen?: { key: string; equals: string | number | boolean };
}

export type EditValues = Record<string, string | number | boolean>;

// NOTE: the modal property editor that consumed these was removed — a modal covers
// the canvas, so you can't see what a style edit does. The live Style panel
// (ui/style-panel.ts) is the single renderer for these descriptors now.

export interface PdfImportChoice {
  mode: 'vector' | 'raster';
  text: 'outline' | 'live';
}

/**
 * Ask how to bring a PDF in: as editable objects (paths/text/images decomposed
 * into layers) or a flattened image; and — for vectors — whether text arrives as
 * outlines (paths) or live re-typeable text. Resolves null if cancelled.
 */
export function choosePdfImportDialog(): Promise<PdfImportChoice | null> {
  let mode: 'vector' | 'raster' = 'vector';
  let text: 'outline' | 'live' = 'outline';

  const seg = (
    wrap: HTMLElement,
    getCurrent: () => string,
    options: { val: string; label: string; hint: string }[],
    set: (v: string) => void,
  ): void => {
    const el = document.createElement('div');
    el.className = 'dlg-seg';
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dlg-seg-btn' + (o.val === getCurrent() ? ' active' : '');
      b.innerHTML = `<span class="dlg-seg-label">${o.label}</span><span class="dlg-seg-hint">${o.hint}</span>`;
      b.addEventListener('click', () => {
        set(o.val);
        el.querySelectorAll('.dlg-seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      });
      el.appendChild(b);
    }
    wrap.appendChild(el);
  };

  return formModal<PdfImportChoice>(
    { title: 'Import PDF', message: 'How should this PDF come in?', confirmText: 'Import', cancelText: 'Cancel' },
    (body) => {
      const field = (labelText: string): HTMLElement => {
        const wrap = document.createElement('div');
        wrap.className = 'dlg-field';
        const l = document.createElement('label');
        l.className = 'dlg-label';
        l.textContent = labelText;
        wrap.appendChild(l);
        body.appendChild(wrap);
        return wrap;
      };

      const modeWrap = field('Import as');
      const textWrap = field('Text');
      const syncText = () => { textWrap.style.display = mode === 'vector' ? '' : 'none'; };

      seg(modeWrap, () => mode, [
        { val: 'vector', label: 'Editable objects', hint: 'Paths, text & images as layers' },
        { val: 'raster', label: 'Flattened image', hint: 'One picture per page' },
      ], (v) => { mode = v as 'vector' | 'raster'; syncText(); });

      seg(textWrap, () => text, [
        { val: 'outline', label: 'Outlines', hint: 'Glyphs → paths, pixel-faithful' },
        { val: 'live', label: 'Live text', hint: 'Re-typeable; font may substitute' },
      ], (v) => { text = v as 'outline' | 'live'; });

      syncText();
    },
    () => ({ mode, text }),
  );
}
