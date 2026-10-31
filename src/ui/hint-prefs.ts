// The "Show Tool Hints" preference (View menu). Kept apart from the strip itself so
// the command registry can read and flip it without importing the strip — which
// imports the registry for its key labels, and would make a cycle.

const STORE_KEY = 'svgmaker.hints';
let enabled = (() => { try { return localStorage.getItem(STORE_KEY) !== '0'; } catch { return true; } })();
const listeners = new Set<() => void>();

export function hintsEnabled(): boolean { return enabled; }

export function setHintsEnabled(on: boolean): void {
  enabled = on;
  try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch { /* storage blocked — session only */ }
  for (const l of listeners) l();
}

export function onHintsChange(cb: () => void): void { listeners.add(cb); }
