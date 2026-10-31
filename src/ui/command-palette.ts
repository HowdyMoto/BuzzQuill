import type { CommandContext, Command } from '../commands';
import { COMMANDS, runCommand, isEnabled, primaryAccelerator } from '../commands';

export interface CommandPalette { open: () => void; }

/**
 * A searchable command palette (Ctrl/Cmd+K) over the command registry. Because
 * every action already declares a label, accelerator and enabled() predicate,
 * the palette is a thin view — it never re-describes commands.
 */
export function createCommandPalette(ctx: CommandContext): CommandPalette {
  const overlay = document.createElement('div');
  overlay.id = 'command-palette';
  overlay.className = 'cmdk-overlay';
  overlay.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'cmdk-panel';

  const input = document.createElement('input');
  input.className = 'cmdk-input';
  input.type = 'text';
  input.placeholder = 'Run a command…';
  input.autocomplete = 'off';
  input.spellcheck = false;

  const list = document.createElement('ul');
  list.className = 'cmdk-list';

  panel.append(input, list);
  overlay.append(panel);
  document.body.append(overlay);

  // Everything except the opener itself (no point listing "open the palette").
  const candidates = COMMANDS.filter(c => c.id !== 'app.command-palette');

  let filtered: Command[] = [];
  let active = 0;

  /** Subsequence match over "label id"; lower score = better, -1 = no match. */
  const score = (cmd: Command, q: string): number => {
    const hay = `${cmd.label} ${cmd.id}`.toLowerCase();
    const idx = hay.indexOf(q);
    if (idx === 0) return 0;
    if (idx > 0) return 1 + idx * 0.001;
    let qi = 0;
    for (let i = 0; i < hay.length && qi < q.length; i++) if (hay[i] === q[qi]) qi++;
    return qi === q.length ? 2 : -1;
  };

  const refresh = (): void => {
    const q = input.value.trim().toLowerCase();
    const scored = candidates
      .map(c => ({ c, s: q ? score(c, q) : 0, en: isEnabled(c, ctx) }))
      .filter(x => x.s >= 0)
      // Match quality first (so "undo" surfaces Undo even while it's disabled),
      // then enabled-before-disabled, then alphabetically.
      .sort((a, b) => (a.s - b.s) || (a.en === b.en ? 0 : a.en ? -1 : 1) || a.c.label.localeCompare(b.c.label));
    filtered = scored.map(x => x.c);
    active = 0;
    render();
  };

  const render = (): void => {
    list.innerHTML = '';
    filtered.forEach((cmd, idx) => {
      const li = document.createElement('li');
      li.className = 'cmdk-item';
      if (idx === active) li.classList.add('active');
      if (!isEnabled(cmd, ctx)) li.classList.add('disabled');

      const cat = document.createElement('span');
      cat.className = 'cmdk-cat';
      cat.textContent = cmd.id.split('.')[0];
      const label = document.createElement('span');
      label.className = 'cmdk-label';
      label.textContent = cmd.label;
      const accel = document.createElement('span');
      accel.className = 'cmdk-accel';
      accel.textContent = primaryAccelerator(cmd);
      li.append(cat, label, accel);

      li.addEventListener('mousedown', (e) => { e.preventDefault(); activate(idx); });
      li.addEventListener('mousemove', () => { if (active !== idx) { active = idx; render(); } });
      list.append(li);
    });
    const activeEl = list.children[active] as HTMLElement | undefined;
    activeEl?.scrollIntoView({ block: 'nearest' });
  };

  const activate = (idx: number): void => {
    const cmd = filtered[idx];
    if (!cmd || !isEnabled(cmd, ctx)) return; // leave open; ignore disabled
    close();
    runCommand(cmd.id, ctx);
  };

  const close = (): void => { overlay.hidden = true; input.value = ''; };

  const open = (): void => {
    overlay.hidden = false;
    input.value = '';
    refresh();
    input.focus();
  };

  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (filtered.length) { active = (active + 1) % filtered.length; render(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (filtered.length) { active = (active - 1 + filtered.length) % filtered.length; render(); } }
    else if (e.key === 'Enter') { e.preventDefault(); activate(active); }
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

  return { open };
}
