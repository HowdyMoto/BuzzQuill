import type { AppState } from '../core/state';
import type { CommandContext } from '../commands';
import { runCommand } from '../commands';
import { showContextMenu, beginInlineRename } from './panel-helpers';

export function updateSymbolsPanel(state: AppState): void {
  const list = document.getElementById('symbols-list')!;
  list.innerHTML = '';

  const renameSymbol = (id: string) => {
    const nameEl = list.querySelector(`li[data-id="${id}"] .layer-name`) as HTMLElement | null;
    const sym = state.symbols.find(s => s.id === id);
    if (!nameEl || !sym) return;
    beginInlineRename(nameEl, sym.name, (newName) => {
      // Through the registry, which also writes the persisted data-name: setting
      // only the model's name was undone by the next rebuild (and never undoable).
      if (newName !== sym.name) state.renameSymbol(id, newName);
    });
  };

  for (const sym of state.symbols) {
    const li = document.createElement('li');
    li.className = 'layer-item';
    if (sym.id === state.selectedSymbolId) li.classList.add('selected');
    li.setAttribute('data-id', sym.id);

    const icon = document.createElement('span');
    icon.className = 'layer-icon';
    icon.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1"/></svg>';

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = sym.name;

    const placeBtn = document.createElement('button');
    placeBtn.className = 'symbol-place-btn';
    placeBtn.textContent = '+';
    placeBtn.title = 'Place instance';
    placeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.placeSymbolInstance(sym.id);
    });

    li.appendChild(icon);
    li.appendChild(name);
    li.appendChild(placeBtn);

    // Select
    li.addEventListener('click', () => {
      state.activePanel = 'symbols';
      state.selectedSymbolId = sym.id;
      state.onChange_public();
    });

    // Click the name of an already-selected symbol to rename it.
    name.addEventListener('click', (e) => {
      if (state.selectedSymbolId === sym.id) {
        e.stopPropagation();
        renameSymbol(sym.id);
      }
    });

    li.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameSymbol(sym.id);
    });

    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      state.activePanel = 'symbols';
      state.selectedSymbolId = sym.id;
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Place instance', action: () => state.placeSymbolInstance(sym.id) },
        { label: 'Rename', action: () => renameSymbol(sym.id) },
        { label: 'Delete', danger: true, action: () => state.removeSymbol(sym.id) },
      ]);
    });

    list.appendChild(li);
  }
}

export function setupSymbolButtons(ctx: CommandContext): void {
  document.getElementById('btn-create-symbol')!.addEventListener('click', (e) => {
    e.stopPropagation();
    runCommand('object.create-symbol', ctx);
  });

  document.getElementById('btn-detach-symbol')!.addEventListener('click', () => {
    runCommand('object.detach-symbol', ctx);
  });
}
