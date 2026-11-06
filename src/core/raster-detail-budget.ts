/** Reserve output pixels before decoding, including the old crops still on screen. */
export function detailEvictions<T>(entries: { key: T; pixels: number; stale: boolean }[], pendingPixels: number, budget: number): T[] | null {
  if (pendingPixels > budget) return null;
  let total = entries.reduce((n, entry) => n + entry.pixels, pendingPixels);
  const evict: T[] = [];
  for (const entry of [...entries].sort((a, b) => Number(b.stale) - Number(a.stale) || b.pixels - a.pixels)) {
    if (total <= budget) break;
    evict.push(entry.key); total -= entry.pixels;
  }
  return evict;
}
