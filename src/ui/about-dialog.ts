import { openModal } from './modal';

/**
 * The "About BuzzQuill" modal. Content only — the overlay, Escape/click-outside
 * dismissal, focus handling and singleton guard come from the shared Modal
 * primitive (ui/modal.ts). Reached via the Help menu and the command palette
 * (the `app.about` command in commands.ts).
 */
export function showAboutDialog(): void {
  const modal = openModal({
    id: 'about-overlay',
    ariaLabel: 'About BuzzQuill',
    dialogClass: 'about-dialog',
  });
  if (!modal) return; // already open (singleton)

  const iconSrc = `${import.meta.env.BASE_URL}icon.svg`;
  modal.dialog.insertAdjacentHTML('beforeend', `
    <img class="about-logo" src="${iconSrc}" alt="" width="72" height="72" />
    <h1 class="about-title">BuzzQuill</h1>
    <div class="about-version">Version ${__APP_VERSION__}<br /><small>Build ${__BUILD_SHA__} · ${__BUILD_DATE__} UTC</small></div>
    <p class="about-tagline">A browser-based SVG editor.</p>
    <div class="about-copyright">© 2026 <a class="about-link" href="https://wrightgeist.com" target="_blank" rel="noopener noreferrer">WrightGeist LLC</a> · <a class="about-link" href="https://github.com/HowdyMoto/BuzzQuill/blob/master/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a></div>
  `);
}
