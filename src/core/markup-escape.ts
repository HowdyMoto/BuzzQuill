const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape text for HTML/XML content OR a quoted attribute (either quote style).
 *
 * The one escaper (#190). There used to be five, and three escaped only `& < >`:
 * safe in element content, but a value that later moved into an attribute could
 * close the quote and inject markup. Escaping all five characters means a call site
 * never has to know which position its string will land in.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

