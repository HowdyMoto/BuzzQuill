// ---------------------------------------------------------------------------
// Id references between SVG elements — finding them, and rewriting them.
//
// SVG paint and geometry are heavily reference-based: `clip-path="url(#s)"`,
// `fill="url(#grad-1)"`, `mask`, `filter`, `marker-*`, `<use href="#x">`. Any time
// artwork moves between documents — an append, a paste — those referenced
// definitions have to travel WITH it and be re-pointed, or the artwork silently
// renders wrong: a lost clip lets shapes sprawl past their intended bounds, and a
// COLLIDING id is worse, quietly binding the newcomer to a stranger's definition.
//
// Both failure modes are silent, which is why this lives in one place instead of
// being re-derived per caller.
// ---------------------------------------------------------------------------

/** `url(#name)` in a presentation attribute or inline style. */
const URL_REF = /url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/g;

/** Every id referenced by `root` or its descendants. */
export function collectRefIds(root: Element): Set<string> {
  const out = new Set<string>();
  const els: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of els) {
    for (const attr of Array.from(el.attributes)) {
      const v = attr.value;
      if (!v.includes('#')) continue;
      for (const m of v.matchAll(URL_REF)) out.add(m[1]);
      if (/^(href|xlink:href)$/i.test(attr.name) && v.startsWith('#')) out.add(v.slice(1));
    }
  }
  return out;
}

/**
 * Rewrite every reference to a key of `map` into its mapped id, across `roots` and
 * their descendants. Ids themselves are left alone — see {@link prefixIds} when the
 * definitions are being renamed too.
 */
export function remapRefs(roots: Element[], map: Map<string, string>): void {
  if (map.size === 0) return;
  for (const root of roots) {
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      for (const attr of Array.from(el.attributes)) {
        const v = attr.value;
        if (!v.includes('#')) continue;
        let out = v.replace(URL_REF, (m, ref: string) => (map.has(ref) ? `url(#${map.get(ref)})` : m));
        if (/^(href|xlink:href)$/i.test(attr.name) && v.startsWith('#')) {
          const ref = v.slice(1);
          if (map.has(ref)) out = `#${map.get(ref)}`;
        }
        if (out !== v) el.setAttribute(attr.name, out);
      }
    }
  }
}

/**
 * Rename every id under `roots` with a unique prefix and rewrite all references to
 * match. Returns the old→new map.
 *
 * Renaming ALL ids, rather than only the ones detected to clash, is deliberate: it
 * leaves no collision check that could be subtly incomplete, and the cost is only a
 * longer id.
 */
export function prefixIds(roots: Element[], token: string): Map<string, string> {
  const map = new Map<string, string>();
  const all: Element[] = [];
  for (const root of roots) all.push(root, ...Array.from(root.querySelectorAll('*')));
  for (const el of all) {
    const id = el.getAttribute('id');
    if (id) map.set(id, `${token}-${id}`);
  }
  if (map.size === 0) return map;
  for (const el of all) {
    const id = el.getAttribute('id');
    if (id && map.has(id)) el.setAttribute('id', map.get(id)!);
  }
  remapRefs(roots, map);
  return map;
}

/**
 * Collect the definition elements `root` references, following references made by
 * those definitions in turn (a clipPath whose path is a `<use>`, a gradient with an
 * `href` base). `lookup` resolves an id to its element in the source document.
 *
 * Returns them in dependency order, deduped, so re-inserting them elsewhere yields
 * a self-contained copy.
 */
export function collectReferencedDefs(root: Element, lookup: (id: string) => Element | null): Element[] {
  const found = new Map<string, Element>();
  const queue = [...collectRefIds(root)];
  while (queue.length) {
    const id = queue.shift()!;
    if (found.has(id)) continue;
    const el = lookup(id);
    // Skip anything already inside the copied artwork — it travels on its own.
    if (!el || root.contains(el)) continue;
    found.set(id, el);
    for (const next of collectRefIds(el)) if (!found.has(next)) queue.push(next);
  }
  return [...found.values()];
}
