/**
 * Right-click context menu driven by the command registry — shared by the canvas
 * and the Layers panel. Each entry resolves a command id to its label + shortcut +
 * enabled state, and runs it through the same `runCommand` path as the top menus, so
 * the menu can never drift from the commands. Operates on the current selection.
 */

import type { CommandContext } from '../commands';
import { getCommand, isEnabled, primaryAccelerator, runCommand } from '../commands';
import { showContextMenu, type ContextMenuItem } from './panel-helpers';

const SEP: ContextMenuItem = { separator: true, label: '', action: () => {} };

/** A menu item from a command id, or null if the command doesn't exist. */
export function commandItem(id: string, ctx: CommandContext): ContextMenuItem | null {
  const cmd = getCommand(id);
  if (!cmd) return null;
  return {
    label: cmd.label,
    accel: primaryAccelerator(cmd) || undefined,
    disabled: !isEnabled(cmd, ctx),
    danger: id === 'edit.delete',
    action: () => runCommand(id, ctx),
  };
}

// The standard selection actions, grouped (separators between groups).
const GROUPS: string[][] = [
  ['edit.cut', 'edit.copy', 'edit.paste', 'edit.paste-in-place', 'edit.duplicate'],
  ['object.group', 'object.ungroup', 'object.clip-make', 'object.clip-edit', 'object.clip-release', 'path.join', 'path.reverse', 'path.flatten'],
  ['object.create-symbol', 'object.pattern-make', 'object.pattern-make-linked', 'object.link-embed', 'library.add-from-selection'],
  ['object.bring-to-front', 'object.send-to-back'],
  ['edit.delete'],
];

/** Build the selection menu, optionally prefixing context-specific items (e.g. a
 *  Layers "Rename"). Groups whose commands are all missing collapse away. */
export function selectionMenuItems(ctx: CommandContext, prefix: ContextMenuItem[] = []): ContextMenuItem[] {
  const items: ContextMenuItem[] = [...prefix];
  for (const group of GROUPS) {
    const built = group.map(id => commandItem(id, ctx)).filter((x): x is ContextMenuItem => !!x);
    if (built.length === 0) continue;
    if (items.length > 0) items.push(SEP);
    items.push(...built);
  }
  return items;
}

/** Show the selection context menu at (x, y). */
export function showSelectionContextMenu(
  x: number, y: number, ctx: CommandContext, prefix: ContextMenuItem[] = [],
): void {
  showContextMenu(x, y, selectionMenuItems(ctx, prefix));
}
