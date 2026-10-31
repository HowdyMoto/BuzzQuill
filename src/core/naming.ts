// ---------------------------------------------------------------------------
// Copy naming — a duplicate/paste keeps the source's name with a counter
// appended ("Logo" → "Logo 2", a copy of "Logo 2" → "Logo 3"), skipping any
// number already taken anywhere in the document. Shared by the clipboard
// (paste) and the layer manager (⌘D duplicate).
// ---------------------------------------------------------------------------

import type { ShapeData } from './types';

/** Every layer name in the shape tree, nested children included. */
export function allShapeNames(shapes: ShapeData[]): Set<string> {
  const out = new Set<string>();
  const visit = (list: ShapeData[]): void => {
    for (const s of list) {
      out.add(s.name);
      if (s.children) visit(s.children);
    }
  };
  visit(shapes);
  return out;
}

/** The name for a copy of `source`: strip any existing trailing counter to get
 *  the stem, then append the first free number (starting after the source's own
 *  counter, or at 2 for an uncounted name). */
export function copyName(source: string, taken: Set<string>): string {
  const m = source.match(/^(.*\S)\s+(\d+)$/);
  const stem = m ? m[1] : source;
  let n = m ? parseInt(m[2], 10) + 1 : 2;
  while (taken.has(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}
