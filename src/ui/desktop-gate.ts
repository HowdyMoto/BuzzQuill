// ---------------------------------------------------------------------------
// Desktop gate — what a phone sees instead of the editor.
//
// BuzzQuill needs a precise pointer, a keyboard and screen room; a phone has none
// of them, and a half-working editor is worse than an honest "not here". So a
// phone gets one screen: the brand mark wrapped in the editor's own selection box,
// a desktop cursor that drags a resize handle until the artwork hits the edge of
// the phone and springs back, and one useful action — send yourself the link.
//
// Loaded by entry.ts, which never imports the editor on a phone. Keep this module
// dependency-free: it is part of the entry chunk every visitor downloads.
// ---------------------------------------------------------------------------

import './desktop-gate.css';

const NS = 'http://www.w3.org/2000/svg';

/** Phones get the gate; tablets and every desktop get the editor. */
export function isPhone(): boolean {
  // `?gate` shows it anywhere, for design review and tests. There is deliberately
  // no switch the other way: the point is that a phone can't wander into the editor.
  if (new URLSearchParams(location.search).has('gate')) return true;
  // Touch-only: a laptop with a touchscreen still has a mouse or trackpad as its
  // primary pointer, so it doesn't match.
  const touchOnly = matchMedia('(hover: none) and (pointer: coarse)').matches;
  // The SCREEN's short side, not the window's: it doesn't change on rotation, and
  // unlike the viewport it doesn't shrink when a tablet's on-screen keyboard opens —
  // a viewport test would slam the gate down over a tablet user mid-typing.
  const shortSide = Math.min(screen.width, screen.height);
  return touchOnly && shortSide < 600;
}

export function showDesktopGate(): void {
  const root = document.documentElement;
  root.classList.add('gate-decided', 'is-phone');
  // Paint the browser's own toolbar in the gate's yellow, so the page runs edge to edge.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#ffff40');

  const gate = document.createElement('main');
  gate.id = 'desktop-gate';
  gate.className = 'dg';

  const art = document.createElement('div');
  art.className = 'dg-art';
  art.appendChild(buildIllustration());
  // Tapping the artwork replays the drag — people poke at things on a phone.
  art.addEventListener('click', () => {
    art.classList.remove('is-playing');
    void art.offsetWidth;                  // restart the CSS animation
    art.classList.add('is-playing');
  });
  art.classList.add('is-playing');

  const copy = document.createElement('div');
  copy.className = 'dg-copy';

  const h1 = document.createElement('h1');
  h1.className = 'dg-title';
  // Broken by hand rather than by `balance`: "Built for / the desktop" is the
  // strongest shape, and a wide enough screen would otherwise set it on one line.
  h1.append('Built for', document.createElement('br'), 'the desktop');

  const body = document.createElement('p');
  body.className = 'dg-body';
  body.textContent =
    'BuzzQuill is a vector editor made for a mouse, a keyboard and a screen with room to spread out. '
    + 'Open it on your computer to start drawing.';

  copy.append(h1, body, buildLinkAction());
  gate.append(art, copy);
  document.body.appendChild(gate);
}

/**
 * The one thing worth doing here: get the link to a computer.
 *
 * The share sheet serves two people — you, sending it to yourself (email, Chrome's
 * "Send to your devices", AirDrop to your Mac), and a friend who is already at a
 * computer. So the button says "Share", which is what the sheet actually does,
 * rather than promising a send-to-self it can't do in one step.
 *
 * Without a share sheet there is no button at all. The fallback used to be "Copy
 * the link", but copying on a phone puts the link on the PHONE's clipboard, which
 * gets nobody any closer to a computer. The address is short enough to type.
 */
function buildLinkAction(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dg-action';

  // The gate may be showing with `?gate`; share the plain app address. (The app has
  // no links to individual documents yet — if it grows them, pass them through here.)
  const url = location.origin + location.pathname;
  const canShare = typeof navigator.share === 'function';

  const host = document.createElement('span');
  host.className = 'dg-host';
  host.textContent = location.host;
  const hint = document.createElement('p');
  hint.className = 'dg-hint';

  if (canShare) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dg-btn';
    btn.textContent = 'Share the link';
    btn.addEventListener('click', async () => {
      try {
        await navigator.share({
          title: 'BuzzQuill',
          text: 'BuzzQuill is a vector editor that runs in your browser. Open it on a computer.',
          url,
        });
      } catch {
        // Dismissing the share sheet is a choice, not an error — say nothing.
      }
    });
    hint.append('Or type ', host, ' on your computer.');
    wrap.append(btn, hint);
  } else {
    hint.classList.add('is-primary');
    hint.append('Type ', host, ' on your computer.');
    wrap.append(hint);
  }
  return wrap;
}

/**
 * The brand's "bq" letterforms, inside the editor's selection chrome, with a desktop
 * cursor on the bottom-right handle. Geometry is the logo's own (public/icon.svg,
 * a 1024 grid) scaled into the art box, so the mark is the real mark.
 */
function buildIllustration(): SVGSVGElement {
  const svg = el('svg', { viewBox: '0 0 320 300', class: 'dg-svg', 'aria-hidden': 'true', focusable: 'false' });

  // Art box 65,70 → 255,229. Selection box pads it by 10.
  const S = 190 / 766;                         // letterform width 142..908 on the logo grid
  const sel = el('g', { class: 'dg-sel' });

  const letters = el('g', {
    transform: `translate(${65 - 142 * S} ${70 - 189 * S}) scale(${S})`,
    fill: 'none', stroke: '#000',
  });
  letters.append(
    el('circle', { cx: 334, cy: 504, r: 143.6, 'stroke-width': 96 }),
    el('circle', { cx: 716.5, cy: 504, r: 143.6, 'stroke-width': 96 }),
    el('line', { x1: 191, y1: 189, x2: 191, y2: 514, 'stroke-width': 74.5 }),
    el('line', { x1: 860, y1: 504, x2: 860, y2: 829, 'stroke-width': 74.5 }),
  );
  sel.appendChild(letters);

  const bx = 55, by = 60, bw = 210, bh = 179;
  sel.appendChild(el('rect', { class: 'dg-box', x: bx, y: by, width: bw, height: bh }));
  const HS = 11;
  for (const [fx, fy] of [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]]) {
    sel.appendChild(el('rect', {
      class: 'dg-handle',
      x: bx + bw * fx - HS / 2, y: by + bh * fy - HS / 2, width: HS, height: HS,
    }));
  }
  svg.appendChild(sel);

  // A classic arrow pointer, tip on the bottom-right handle — the one thing a phone
  // doesn't have.
  const cursor = el('g', { class: 'dg-cursor' });
  const tip = el('g', { transform: `translate(${bx + bw} ${by + bh}) scale(1.45)` });
  tip.appendChild(el('path', {
    d: 'M0 0 L0 17.5 L4.6 13.4 L7.6 20.3 L10.6 19 L7.7 12.2 L13.6 12.2 Z',
    fill: '#000', stroke: '#fff', 'stroke-width': 1.4, 'stroke-linejoin': 'round',
  }));
  cursor.appendChild(tip);
  svg.appendChild(cursor);
  return svg;
}

function el<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const k in attrs) node.setAttribute(k, String(attrs[k]));
  return node;
}
