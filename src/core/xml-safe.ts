/** Make serialized HTML valid for XML re-parse: `&nbsp;` isn't a defined XML
 *  entity, so map it to its numeric form. Shared by AppState's history capture
 *  and SvgIoManager's defs/drawing-layer serialization. */
export function xmlSafeMarkup(html: string): string {
  return html.replace(/&nbsp;/g, '&#160;');
}
