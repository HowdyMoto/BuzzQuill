// ---------------------------------------------------------------------------
// Privacy Policy + Terms of Service modal.
//
// Self-contained like about-dialog.ts: own overlay, Escape / click-outside to
// close, capture-phase key handling so canvas shortcuts can't fire behind it.
// Deliberately plain and short — edit the copy below as the product matures.
// Not legal advice; a simple, honest starting point.
// ---------------------------------------------------------------------------

import { openModal } from './modal';

/** Where Feedback & Support and the policies send people. Lives here, not in
 *  commands.ts, because commands.ts imports this module — the other way round
 *  would be a cycle that reads the constant before it exists. */
export const ISSUES_URL = 'https://github.com/HowdyMoto/BuzzQuill/issues';

const EFFECTIVE = 'October 26, 2026';
const ISSUES_LINK = `<a href="${ISSUES_URL}" target="_blank" rel="noopener noreferrer">issue tracker</a>`;

const PRIVACY = `
  <h2>Privacy Policy</h2>
  <p class="legal-date">Effective ${EFFECTIVE}</p>
  <p>BuzzQuill is a browser-based vector editor. Your drawings are created and
  kept in your browser and in the files you choose to save them to. BuzzQuill
  runs no server of its own: we never see, collect, or store your artwork.</p>
  <h3>What we collect</h3>
  <p>Nothing. There are no accounts and no analytics. Opening and saving files
  uses your browser's own file picker, so the only copies of your work are the
  ones you make.</p>
  <h3>Google Drive</h3>
  <p>If you choose to connect Google Drive, BuzzQuill asks Google only for
  permission to the files you open with it or create with it (the
  <code>drive.file</code> scope) &mdash; never your whole Drive. File contents
  travel directly between your browser and Google; nothing passes through us, and
  we keep no record of your Google account. The sign-in token is kept in this tab's session storage and expires
  after about an hour. Disconnect Google Drive clears it locally and requests
  revocation from Google. If Google cannot confirm revocation (for example, the
  token has expired or you are offline), remove BuzzQuill's access from your
  Google account's security settings. Browser session restore may restore tab
  storage, so use Disconnect on a shared device.</p>
  <h3>Local storage</h3>
  <p>Preferences, your recent-files lists and a snapshot of your open documents
  (so they come back after a reload) live in your browser (localStorage and
  IndexedDB) and never leave your device.</p>
  <h3>Questions</h3>
  <p>The source code is public, and questions or reports are welcome on our
  ${ISSUES_LINK}. This policy is also published at
  <a href="privacy.html" target="_blank" rel="noopener noreferrer">/privacy.html</a>.</p>
`;

const TERMS = `
  <h2>Terms of Service</h2>
  <p class="legal-date">Effective ${EFFECTIVE}</p>
  <p>By using BuzzQuill, you agree to these terms. If you don't agree, please
  don't use the app.</p>
  <h3>Your content</h3>
  <p>You keep all rights to the artwork you create. You're responsible for what
  you make, and you agree not to use BuzzQuill for unlawful content or to
  infringe others' rights.</p>
  <h3>Availability &amp; warranty</h3>
  <p>BuzzQuill is provided "as is" and "as available", without warranties of any
  kind. We may change, suspend, or discontinue features at any time. Keep your own
  backups by saving and exporting your files — we're not responsible for lost
  work.</p>
  <h3>Limitation of liability</h3>
  <p>To the maximum extent permitted by law, WrightGeist LLC is not liable for any
  indirect or consequential damages arising from your use of BuzzQuill.</p>
  <h3>Changes</h3>
  <p>We may update these terms; continued use after a change means you accept it.
  Questions? Reach us on our ${ISSUES_LINK}.</p>
`;

/** Open the legal modal, scrolled to the requested section. Overlay lifecycle
 *  (Escape / click-outside / focus / singleton) is all handled by the shared
 *  Modal primitive. */
export function showLegalDialog(section: 'privacy' | 'terms' = 'privacy'): void {
  const modal = openModal({
    id: 'legal-overlay',
    ariaLabel: 'Privacy Policy and Terms of Service',
    dialogClass: 'legal-dialog',
  });
  if (!modal) return; // singleton already open
  const { dialog } = modal;

  dialog.insertAdjacentHTML('beforeend', `
    <h1 class="about-title legal-heading">Privacy &amp; Terms</h1>
    <nav class="legal-tabs">
      <button type="button" class="legal-tab" data-goto="privacy">Privacy Policy</button>
      <button type="button" class="legal-tab" data-goto="terms">Terms of Service</button>
    </nav>
    <div class="legal-body">
      <section id="legal-privacy">${PRIVACY}</section>
      <section id="legal-terms">${TERMS}</section>
    </div>
  `);

  const body = dialog.querySelector('.legal-body') as HTMLElement;
  const goTo = (which: string): void => {
    const target = dialog.querySelector(`#legal-${which}`) as HTMLElement | null;
    if (target) body.scrollTop = target.offsetTop - body.offsetTop;
  };
  dialog.querySelectorAll<HTMLButtonElement>('.legal-tab').forEach((tab) =>
    tab.addEventListener('click', () => goTo(tab.dataset.goto!)));

  goTo(section);
}
