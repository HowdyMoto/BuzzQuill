// ---------------------------------------------------------------------------
// Author stylesheets — hand `<style>` class paint over to editable attributes.
//
// Illustrator's default SVG export ("Internal CSS") paints through class rules:
// `.cls-1{fill:none;stroke:#000;stroke-width:4px}`. The editor writes paint as
// presentation ATTRIBUTES, and an attribute is the weakest layer of the CSS
// cascade — any stylesheet rule beats it. So on such a file every Fill / Stroke
// edit was written to the element, shown in the panel, and never drawn.
//
// resolveAuthorStyles records what every element renders with, deletes the
// editable declarations from the rules, then puts an attribute back wherever the
// rendering moved. Comparing computed values rather than interpreting selectors
// gets specificity, !important, compound selectors and inheritance right without
// a CSS engine of our own. Whatever else the stylesheet says (font faces, blend
// modes, …) stays in the stylesheet.
// ---------------------------------------------------------------------------

/**
 * Properties the editor writes as presentation attributes — a stylesheet rule
 * setting any of them would silently override every edit. Deliberately limited to
 * real presentation attributes: blend mode and isolation have no attribute form
 * (blend mode is `data-blend`, owned by core/compositing.ts), so moving them onto
 * an attribute would drop them.
 */
export const AUTHOR_STYLE_PROPS: readonly string[] = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
  'stroke-dashoffset', 'opacity', 'font-family', 'font-size', 'font-weight',
  'font-style', 'letter-spacing', 'text-anchor', 'rx', 'ry',
];

/** How deep a chain of inherited changes we'll chase before giving up. */
const MAX_ROUNDS = 32;

/** Never rendered, so there is nothing to preserve on them. */
const NON_RENDERED = new Set(['style', 'metadata', 'title', 'desc', 'script']);

type Sheeted = Element & { sheet: CSSStyleSheet | null };

const isStyleRule = (r: CSSRule): r is CSSStyleRule => 'selectorText' in r && 'style' in r;
const nestedRules = (r: CSSRule): CSSRuleList | null =>
  'cssRules' in r ? (r as unknown as CSSGroupingRule).cssRules : null;

/** Every style rule in `list`, including those nested in @media / @supports / CSS nesting. */
function collectStyleRules(list: CSSRuleList, out: CSSStyleRule[]): void {
  for (const rule of Array.from(list)) {
    if (isStyleRule(rule)) out.push(rule);
    const nested = nestedRules(rule);
    if (nested) collectStyleRules(nested, out);
  }
}

/** A sheet's text with emptied style rules dropped — `.cls-1 {}` is just noise. */
function sheetText(list: CSSRuleList): string {
  return Array.from(list)
    .filter((r) => !(isStyleRule(r) && r.style.length === 0 && !nestedRules(r)?.length))
    .map((r) => r.cssText)
    .join('\n');
}

/**
 * A computed value as attribute text: `url("…#id")` → `url(#id)` (computed style
 * may resolve the reference against the page URL, which breaks on export), and
 * `4px` → `4` (user units — same rendering, plainer markup).
 */
function attributeValue(prop: string, value: string): string {
  let out = value.replace(/url\(\s*(["']?)[^"')#]*#([^"')]+)\1\s*\)/g, 'url(#$2)');
  if (prop !== 'font-family') out = out.replace(/(\d)px\b/g, '$1');
  return out;
}

/**
 * Hand the {@link AUTHOR_STYLE_PROPS} that `styles` declare over to presentation
 * attributes on `targets`, without changing what renders. `targets` is a getter so
 * the common case — no stylesheet declares any of them — never walks the tree.
 * Everything must be connected: the comparison reads computed style. Returns true
 * when anything was rewritten.
 */
export function resolveAuthorStyles(styles: readonly Element[], targets: () => Element[]): boolean {
  const sheets: Array<{ el: Element; rules: CSSStyleRule[] }> = [];
  for (const el of styles) {
    const sheet = (el as Sheeted).sheet;
    if (!sheet) continue;
    const rules: CSSStyleRule[] = [];
    collectStyleRules(sheet.cssRules, rules);
    sheets.push({ el, rules });
  }
  const props = AUTHOR_STYLE_PROPS.filter((p) =>
    sheets.some((s) => s.rules.some((r) => r.style.getPropertyValue(p) !== '')));
  if (props.length === 0) return false;

  // 1. What everything renders with while the rules still apply.
  const els = targets().filter((el) => !NON_RENDERED.has(el.localName));
  const before = els.map((el) => {
    const cs = getComputedStyle(el);
    return props.map((p) => cs.getPropertyValue(p));
  });

  // 2. Take the declarations out of the rules — and out of the markup, which is
  //    what saves and history see (a CSSOM edit doesn't touch the <style>'s text).
  for (const { el, rules } of sheets) {
    let changed = false;
    for (const r of rules) {
      for (const p of props) {
        if (r.style.getPropertyValue(p) === '') continue;
        r.style.removeProperty(p);
        changed = true;
      }
    }
    if (!changed) continue;
    const text = sheetText((el as Sheeted).sheet!.cssRules);
    if (text.trim()) el.textContent = text;
    else el.remove();
  }

  // 3. Put an attribute back wherever the rendering moved. Only the TOPMOST moved
  //    element per property is fixed each round: a child that merely inherited the
  //    old value recovers from its parent's attribute, and pinning a copy onto it
  //    too would stop the parent group's paint reaching it (#208). Rounds repeat
  //    until nothing moves — the nesting depth, in practice one or two. A value an
  //    attribute can't restore (a non-author rule outranks it) is tried once.
  const index = new Map(els.map((el, i) => [el, i]));
  const tried = new Set<number>(); // i * props.length + j
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const moved: Array<[number, number]> = [];
    const movedEls = props.map(() => new Set<Element>());
    els.forEach((el, i) => {
      const cs = getComputedStyle(el); // all reads before any write: one style recalc per round
      props.forEach((p, j) => {
        if (cs.getPropertyValue(p) === before[i][j]) return;
        moved.push([i, j]);
        movedEls[j].add(el);
      });
    });
    // Decide the whole round against `tried` as it stood when the round began, then write.
    const fix = moved.filter(([i, j]) => {
      if (tried.has(i * props.length + j)) return false;
      const parent = els[i].parentElement;
      if (!parent || !movedEls[j].has(parent)) return true;
      return tried.has(index.get(parent)! * props.length + j); // parent couldn't be restored
    });
    if (fix.length === 0) break;
    for (const [i, j] of fix) {
      tried.add(i * props.length + j);
      els[i].setAttribute(props[j], attributeValue(props[j], before[i][j]));
    }
  }
  return true;
}
