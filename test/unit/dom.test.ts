import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../../src/ui/dom';

describe('escapeHtml (#190)', () => {
  it('escapes element content and BOTH attribute quote styles', () => {
    expect(escapeHtml(`Tom & <tag title="x" data-y='z'>`)).toBe(
      'Tom &amp; &lt;tag title=&quot;x&quot; data-y=&#39;z&#39;&gt;',
    );
  });

  it('escapes & first, so existing entities are not double-decoded into markup', () => {
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('Frame 1 — draft (v2)')).toBe('Frame 1 — draft (v2)');
  });

});
