import type { Point } from './types';

/** Grid coordinates are always in drawing-layer space, independent of path transforms. */
export function snapPointToGrid(point: Point, grid: { ox: number; oy: number; sx: number; sy: number } | null): Point {
  if (!grid || grid.sx <= 0 || grid.sy <= 0) return point;
  return { x: grid.ox + Math.round((point.x - grid.ox) / grid.sx) * grid.sx,
    y: grid.oy + Math.round((point.y - grid.oy) / grid.sy) * grid.sy };
}
