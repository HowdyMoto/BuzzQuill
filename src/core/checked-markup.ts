/** DOM serialization can silently return an empty string above Chromium's string limit. */
export function checkedInnerHTML(root: Element): string {
  const markup = root.innerHTML;
  if (root.hasChildNodes() && !markup) throw new Error('The drawing could not be serialized safely. Nothing was saved. Keep this tab open and save a smaller copy.');
  return markup;
}
export function checkedOuterHTML(root: Element): string {
  const markup = root.outerHTML;
  if (!markup) throw new Error('The drawing could not be serialized safely. Nothing was saved.');
  return markup;
}
