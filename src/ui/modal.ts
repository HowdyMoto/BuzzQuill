// ---------------------------------------------------------------------------
// Modal — the one reusable centered-dialog primitive.
//
// Before this, every dialog (About, Export, sign-in, …) re-implemented the same
// lifecycle by hand — backdrop, Escape-to-close, click-outside, focus capture &
// restore, a singleton guard, and an ad-hoc z-index — and some (Export) silently
// omitted half of it. openModal() owns all of that once, so a new dialog is just
// its content. Styling lives in the token-based `.modal-*` classes in style.css.
//
// Scope: centered modal dialogs. Anchored popovers (color picker, command
// palette, account menu) have their own positioning and are intentionally not
// built on this.
// ---------------------------------------------------------------------------

export interface ModalOptions {
  /** Singleton guard: if an element with this id already exists, openModal is a
   *  no-op and returns null (prevents stacking, e.g. menu click + ⌘K). */
  id?: string;
  /** Accessible name for the dialog (aria-label). */
  ariaLabel: string;
  /** Extra class(es) on the dialog box for size/padding/content-specific styling
   *  (e.g. 'about-dialog'). The shared surface comes from `.modal-dialog`. */
  dialogClass?: string;
  /** Render the ✕ close button in the corner (default true). */
  closeButton?: boolean;
  /** Run on close (after teardown) — e.g. to drop external listeners. */
  onClose?: () => void;
}

/** The standard "focusable" selector. Everything a user can Tab to; the visible/
 *  enabled filtering happens in focusablesIn(). */
const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Focusable descendants of the dialog, in DOM (tab) order. Disabled, hidden and
 *  aria-hidden controls are dropped — Tab skips them natively, so including them
 *  would put the wrap point on an element the user can never land on. */
function focusablesIn(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0),
  );
}

export interface ModalHandle {
  overlay: HTMLElement;
  /** The dialog box — append your content here. */
  dialog: HTMLElement;
  /** Close and tear down (idempotent). */
  close: () => void;
}

/**
 * Open a centered modal dialog. Returns a handle whose `dialog` you fill with
 * content, or null if a singleton with the same `id` is already open.
 */
export function openModal(opts: ModalOptions): ModalHandle | null {
  if (opts.id && document.getElementById(opts.id)) return null; // already open

  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = document.createElement('div');
  if (opts.id) overlay.id = opts.id;
  overlay.className = 'modal-overlay';

  const dialog = document.createElement('div');
  dialog.className = opts.dialogClass ? `modal-dialog ${opts.dialogClass}` : 'modal-dialog';
  dialog.tabIndex = -1; // focus target on open — avoids a stray ring on a control
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', opts.ariaLabel);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    prevFocus?.focus?.();
    opts.onClose?.();
  };

  // Capture phase so this pre-empts the global shortcut handler in main.ts:
  // stray/destructive keys (a tool key, Delete on a shape behind the modal) must
  // not fire while the dialog is up. Escape closes; everything else is swallowed.
  //
  // Stacking: modals append in order, so the LAST `.modal-overlay` in the DOM is
  // the topmost. Only it closes on Escape — a modal opened over another (e.g. the
  // contact dialog over the legal dialog) is dismissed first and the one beneath
  // stays put, with no per-dialog "yield" logic.
  const isTopmost = (): boolean => {
    const all = document.querySelectorAll('.modal-overlay');
    return all[all.length - 1] === overlay;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (!isTopmost()) return; // a modal stacked above us owns Escape
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      return;
    }
    // Focus trap: a modal dialog owns the tab sequence while it's up. Without
    // this, Tab walks straight out of the dialog into the app behind it (the
    // toolbar, panels, canvas) — the dialog stays visible but the keyboard is
    // somewhere else entirely, which is both a WCAG 2.4.3/2.1.2 failure and a
    // way to "click" hidden UI. Wrap at both ends, and pull focus back in if it
    // ever escaped (or is still on the dialog box itself, where it starts).
    if (e.key === 'Tab') {
      if (!isTopmost()) return; // the modal stacked above us owns the tab loop
      e.stopPropagation();
      const items = focusablesIn(dialog);
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus({ preventScroll: true }); // nothing to land on — stay put
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && active !== dialog && dialog.contains(active);
      // Only the ends (and a focus that already escaped, e.g. it's still on the
      // dialog box itself) are redirected — the interior keeps the browser's own
      // tab order, so composite controls still behave natively.
      if (!inside || (e.shiftKey ? active === first : active === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
      return;
    }
    e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);

  if (opts.closeButton !== false) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', close);
    dialog.appendChild(closeBtn);
  }

  // Click on the backdrop (but not the dialog) dismisses.
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  dialog.focus({ preventScroll: true });

  return { overlay, dialog, close };
}
