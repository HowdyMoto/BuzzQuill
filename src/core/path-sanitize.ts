/**
 * Path data sanitization for imported SVGs.
 *
 * Editors like Inkscape sometimes leave behind degenerate subpaths — most
 * commonly a closed subpath whose anchor points all coincide while its control
 * points fling out to some far coordinate (often the origin). Such a subpath
 * encloses no area, so it is invisible when filled, but when stroked it renders
 * as a stray line shooting off across (and beyond) the artboard.
 *
 * `sanitizePathData` parses a `d` string into subpaths, drops any whose anchor
 * points span a near-zero bounding box, and re-emits the rest. Open subpaths
 * (legitimate lines) span a real distance between anchors and are preserved;
 * only the collapsed-to-a-point junk is removed.
 */

import { tokenizePath } from './path-model';

interface SubPath {
  /** Normalized command text for this subpath (e.g. "M 1 2 L 3 4 Z"). */
  text: string;
  /** Absolute anchor (on-curve) points; control points are excluded. */
  anchors: { x: number; y: number }[];
}

/** Anchor bbox below this size (user units) is treated as collapsed-to-a-point. */
const EPSILON = 0.05;

function fmt(n: number): string {
  // Trim float noise while keeping precision; avoids "-0".
  const r = Math.round(n * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
}

/**
 * Remove degenerate (zero-extent) subpaths from a path `d` string.
 * Returns the cleaned `d` and the number of subpaths removed.
 */
export function sanitizePathData(d: string): { d: string; removed: number } {
  const tokens = tokenizePath(d);
  if (tokens.length === 0) return { d, removed: 0 };

  const subpaths: SubPath[] = [];
  let cur: SubPath | null = null;
  let cx = 0, cy = 0;       // current point
  let sx = 0, sy = 0;       // subpath start

  const pushAnchor = () => cur && cur.anchors.push({ x: cx, y: cy });

  for (const { cmd, args } of tokens) {
    const lower = cmd.toLowerCase();
    const rel = cmd !== cmd.toUpperCase() && lower !== 'z';

    if (lower === 'm') {
      // Begin a new subpath.
      if (cur) subpaths.push(cur);
      cx = rel ? cx + args[0] : args[0];
      cy = rel ? cy + args[1] : args[1];
      sx = cx; sy = cy;
      cur = { text: `M ${fmt(cx)} ${fmt(cy)}`, anchors: [] };
      pushAnchor();
      continue;
    }
    if (!cur) continue; // malformed: data before any moveto

    switch (lower) {
      case 'l':
        cx = rel ? cx + args[0] : args[0];
        cy = rel ? cy + args[1] : args[1];
        cur.text += ` L ${fmt(cx)} ${fmt(cy)}`;
        break;
      case 'h':
        cx = rel ? cx + args[0] : args[0];
        cur.text += ` L ${fmt(cx)} ${fmt(cy)}`;
        break;
      case 'v':
        cy = rel ? cy + args[0] : args[0];
        cur.text += ` L ${fmt(cx)} ${fmt(cy)}`;
        break;
      case 'c':
        cx = rel ? cx + args[4] : args[4];
        cy = rel ? cy + args[5] : args[5];
        cur.text += ` C ${fmt(rel ? cx - args[4] + args[0] : args[0])} ${fmt(rel ? cy - args[5] + args[1] : args[1])}` +
          ` ${fmt(rel ? cx - args[4] + args[2] : args[2])} ${fmt(rel ? cy - args[5] + args[3] : args[3])}` +
          ` ${fmt(cx)} ${fmt(cy)}`;
        break;
      case 's':
        cx = rel ? cx + args[2] : args[2];
        cy = rel ? cy + args[3] : args[3];
        cur.text += ` S ${fmt(rel ? cx - args[2] + args[0] : args[0])} ${fmt(rel ? cy - args[3] + args[1] : args[1])}` +
          ` ${fmt(cx)} ${fmt(cy)}`;
        break;
      case 'q':
        cx = rel ? cx + args[2] : args[2];
        cy = rel ? cy + args[3] : args[3];
        cur.text += ` Q ${fmt(rel ? cx - args[2] + args[0] : args[0])} ${fmt(rel ? cy - args[3] + args[1] : args[1])}` +
          ` ${fmt(cx)} ${fmt(cy)}`;
        break;
      case 't':
        cx = rel ? cx + args[0] : args[0];
        cy = rel ? cy + args[1] : args[1];
        cur.text += ` T ${fmt(cx)} ${fmt(cy)}`;
        break;
      case 'a':
        cx = rel ? cx + args[5] : args[5];
        cy = rel ? cy + args[6] : args[6];
        cur.text += ` A ${fmt(args[0])} ${fmt(args[1])} ${fmt(args[2])} ${fmt(args[3])} ${fmt(args[4])} ${fmt(cx)} ${fmt(cy)}`;
        break;
      case 'z':
        cx = sx; cy = sy;
        cur.text += ' Z';
        break;
    }
    pushAnchor();
  }
  if (cur) subpaths.push(cur);

  let removed = 0;
  const kept = subpaths.filter((sp) => {
    if (sp.anchors.length === 0) { removed++; return false; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of sp.anchors) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const degenerate = (maxX - minX) < EPSILON && (maxY - minY) < EPSILON;
    if (degenerate) removed++;
    return !degenerate;
  });

  if (removed === 0) return { d, removed: 0 };
  return { d: kept.map((sp) => sp.text).join(' '), removed };
}
