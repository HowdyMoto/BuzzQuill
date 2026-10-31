// ---------------------------------------------------------------------------
// The page's entry point: decide BEFORE the editor loads whether to load it.
//
// The editor is a mouse-and-keyboard tool and roughly a megabyte of JavaScript.
// On a phone it cannot be used, so a phone gets the desktop gate instead and never
// downloads, parses or boots the editor — no wasted data, battery, session restore
// or service-worker install for an app nobody there can drive.
//
// The stylesheet is imported here rather than only in main.ts so it stays in the
// entry's render-blocking CSS: were it to arrive with the lazily-imported editor
// chunk, desktop visitors would see the unstyled shell flash before it applied.
// ---------------------------------------------------------------------------

import './style.css';
import { retireBrowserCredentials } from './core/legacy-session-cleanup';
import { isPhone, showDesktopGate } from './ui/desktop-gate';

retireBrowserCredentials();

if (isPhone()) {
  showDesktopGate();
} else {
  document.documentElement.classList.add('gate-decided');
  void import('./main');
}
