/**
 * Searchable, previewed font picker — a custom combobox that replaces the plain
 * <select id="prop-font-family">. Each family previews in its own face; type to filter;
 * recently-used families float to the top. Built as a singleton (there is one font
 * picker in the app). This is also the front door for a future large font catalog
 * (see issue #101): the search + grouped list scales to hundreds of families.
 *
 * Usage: setupFontPicker(root, groups, onPick) once at boot; setFontPickerValue(family)
 * from the properties readback to reflect the current selection (does NOT fire onPick).
 */

export interface FontMenuGroup { label: string; families: string[]; }

const RECENTS_KEY = 'bq-font-recents';
const MAX_RECENTS = 5;

interface Els {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  current: HTMLElement;
  menu: HTMLElement;
  search: HTMLInputElement;
  list: HTMLElement;
}

let els: Els | null = null;
let groups: FontMenuGroup[] = [];
let known = new Set<string>();
let onPick: (family: string) => void = () => {};
let currentFamily = '';
let items: HTMLButtonElement[] = []; // currently-rendered, selectable list items (in order)
let hl = -1;                          // highlighted index within `items`

function getRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && known.has(x)) : [];
  } catch { return []; }
}

function addRecent(family: string): void {
  try {
    const next = [family, ...getRecents().filter((f) => f !== family)].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch { /* private mode / disabled storage — recents are a nicety, ignore */ }
}

const isOpen = (): boolean => !!els && !els.menu.hidden;

/** Component styles, injected once. Kept in-module (not style.css) so this widget is
 *  fully self-contained; uses the app's --ai-* design tokens for theme consistency. */
function injectStyles(): void {
  if (document.getElementById('fp-styles')) return;
  const el = document.createElement('style');
  el.id = 'fp-styles';
  el.textContent = `
.font-picker { position: relative; flex: 1; min-width: 0; }
.font-picker-trigger {
  width: 100%; height: 20px; display: flex; align-items: center; gap: 4px;
  background: var(--ai-input); color: var(--ai-text);
  border: 1px solid var(--ai-border-light); border-radius: 2px;
  padding: 0 4px; cursor: pointer; font-size: 12px; text-align: left;
}
.font-picker-trigger:hover { border-color: var(--ai-text-dim); }
.font-picker-trigger.open { border-color: var(--ai-accent); }
.font-picker-trigger .fp-current { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.font-picker-trigger .fp-current.fp-mixed { color: var(--ai-text-dim); font-style: italic; }
.font-picker-trigger svg { flex: 0 0 auto; color: var(--ai-text-dim); }
.font-picker-menu {
  position: fixed; z-index: 3000; display: flex; flex-direction: column; gap: 5px;
  background: var(--ai-menu-bg, var(--ai-panel));
  border: 1px solid var(--ai-border-light); border-radius: 5px;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.45); padding: 5px;
}
.font-picker-menu[hidden] { display: none; }
.fp-search {
  height: 24px; flex: 0 0 auto; background: var(--ai-input); color: var(--ai-text);
  border: 1px solid var(--ai-border-light); border-radius: 3px; padding: 0 6px; font-size: 12px;
}
.fp-search:focus { outline: none; border-color: var(--ai-accent); }
/* flex:1 + min-height:0 lets the list take the menu's remaining height and SCROLL its
   overflow instead of letting the flex column crush the rows. */
.fp-list { overflow-y: auto; display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.fp-group {
  flex: 0 0 auto;
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ai-text-dim);
  padding: 7px 6px 3px; position: sticky; top: 0; background: var(--ai-menu-bg, var(--ai-panel));
}
/* flex-shrink:0 is critical: without it a height-constrained menu squishes every row to
   a few px (clipping the name to slivers) instead of scrolling. */
.fp-item {
  flex: 0 0 auto;
  text-align: left; background: none; border: none; color: var(--ai-text);
  padding: 5px 7px; border-radius: 3px; cursor: pointer; font-size: 15px; line-height: 1.2;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fp-item.hl { background: var(--ai-menu-hover, var(--ai-btn-hover)); }
.fp-item.active { color: var(--ai-accent); }
.fp-empty { color: var(--ai-text-dim); font-size: 12px; padding: 12px 6px; text-align: center; }
`;
  document.head.appendChild(el);
}

function svgIcon(path: string, size = 12): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', path); svg.appendChild(p);
  return svg;
}

export function setupFontPicker(root: HTMLElement, g: FontMenuGroup[], pick: (family: string) => void): void {
  injectStyles();
  groups = g;
  known = new Set(g.flatMap((grp) => grp.families));
  onPick = pick;

  root.classList.add('font-picker');
  root.replaceChildren();

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'font-picker-trigger';
  const current = document.createElement('span');
  current.className = 'fp-current';
  trigger.appendChild(current);
  trigger.appendChild(svgIcon('M4 6l4 4 4-4', 11)); // chevron down
  root.appendChild(trigger);

  const menu = document.createElement('div');
  menu.className = 'font-picker-menu';
  menu.hidden = true;
  const search = document.createElement('input');
  search.className = 'fp-search'; search.type = 'text'; search.placeholder = 'Search fonts…'; search.spellcheck = false;
  const list = document.createElement('div');
  list.className = 'fp-list';
  menu.appendChild(search); menu.appendChild(list);
  // Portal the menu to <body>: the right panel (#panels) clips with overflow, so an
  // in-panel dropdown would be cut off. Fixed-positioned at the trigger's rect on open.
  document.body.appendChild(menu);

  els = { root, trigger, current, menu, search, list };

  trigger.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? close() : open(); });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  search.addEventListener('input', () => render(search.value));
  search.addEventListener('keydown', onSearchKey);
  // Close on outside interaction. Pointerdown (not click) so it beats the trigger's toggle.
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (isOpen() && els && !els.trigger.contains(t) && !els.menu.contains(t)) close();
  });
}

/** Anchor the portaled menu under the trigger, capped to the space below. */
function positionMenu(): void {
  if (!els) return;
  const r = els.trigger.getBoundingClientRect();
  const m = els.menu;
  m.style.left = `${Math.round(r.left)}px`;
  m.style.top = `${Math.round(r.bottom + 3)}px`;
  m.style.width = `${Math.round(r.width)}px`;
  m.style.maxHeight = `${Math.max(180, Math.round(window.innerHeight - r.bottom - 12))}px`;
}

/** Reflect the current selection in the trigger (does NOT fire onPick). '' → Mixed. */
export function setFontPickerValue(family: string): void {
  currentFamily = family;
  if (!els) return;
  if (family) {
    els.current.textContent = family;
    els.current.style.fontFamily = `'${family}'`;
    els.current.classList.remove('fp-mixed');
  } else {
    els.current.textContent = 'Mixed';
    els.current.style.fontFamily = '';
    els.current.classList.add('fp-mixed');
  }
}

function open(): void {
  if (!els) return;
  els.menu.hidden = false;
  els.trigger.classList.add('open');
  positionMenu();
  els.search.value = '';
  render('');
  els.search.focus();
  // Scroll the active item into view.
  const active = els.list.querySelector('.fp-item.active') as HTMLElement | null;
  active?.scrollIntoView({ block: 'center' });
  window.addEventListener('scroll', positionMenu, true);
  window.addEventListener('resize', positionMenu);
}

function close(): void {
  if (!els) return;
  els.menu.hidden = true;
  els.trigger.classList.remove('open');
  hl = -1;
  window.removeEventListener('scroll', positionMenu, true);
  window.removeEventListener('resize', positionMenu);
}

function choose(family: string): void {
  addRecent(family);
  setFontPickerValue(family);
  close();
  els?.trigger.focus();
  onPick(family);
}

function render(filter: string): void {
  if (!els) return;
  els.list.replaceChildren();
  items = [];
  const f = filter.trim().toLowerCase();

  const shown: FontMenuGroup[] = [];
  if (!f) {
    const recents = getRecents();
    if (recents.length) shown.push({ label: 'Recent', families: recents });
  }
  for (const g of groups) shown.push(g);

  for (const g of shown) {
    const fams = f ? g.families.filter((fam) => fam.toLowerCase().includes(f)) : g.families;
    if (!fams.length) continue;
    const header = document.createElement('div');
    header.className = 'fp-group'; header.textContent = g.label;
    els.list.appendChild(header);
    for (const fam of fams) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'fp-item';
      item.textContent = fam;
      item.style.fontFamily = `'${fam}'`;
      item.dataset.family = fam;
      if (fam === currentFamily) item.classList.add('active');
      item.addEventListener('click', () => choose(fam));
      item.addEventListener('pointermove', () => setHighlight(items.indexOf(item)));
      els.list.appendChild(item);
      items.push(item);
    }
  }

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'fp-empty'; empty.textContent = 'No fonts match';
    els.list.appendChild(empty);
  }
  // Start the highlight on the current family if visible, else the first item.
  hl = items.findIndex((i) => i.dataset.family === currentFamily);
  if (hl < 0 && items.length) hl = 0;
  paintHighlight();
}

function setHighlight(i: number): void {
  if (i < 0 || i >= items.length) return;
  hl = i; paintHighlight();
}

function paintHighlight(): void {
  items.forEach((it, i) => it.classList.toggle('hl', i === hl));
}

function moveHighlight(delta: number): void {
  if (!items.length) return;
  hl = (hl + delta + items.length) % items.length;
  paintHighlight();
  items[hl].scrollIntoView({ block: 'nearest' });
}

function onSearchKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); if (hl >= 0 && items[hl]) choose(items[hl].dataset.family!); }
  else if (e.key === 'Escape') { e.preventDefault(); close(); els?.trigger.focus(); }
}
