import { test, expect } from '@playwright/test';

/**
 * Where a document lives is ONE value (core/doc-source.ts) instead of a file
 * handle and a cloud tether kept in sync by hand. These pin the user-visible
 * consequences: a fresh document has no source, renaming a tab changes its name
 * and nothing else, a session written by the old cloud-backed build still comes
 * back (as an unsaved document, title kept), and the account/cloud chrome is gone
 * while the local-file chrome stays.
 */

type DocsWindow = Window & {
  state: { dirty: boolean };
  docs: {
    tabs: { title: string; source: unknown }[];
    activeId: string;
    active: { title: string };
    activeSource: unknown;
    renameTab(id: string, title: string): void;
  };
};

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<DocsWindow>;
    return !!w.state && !!w.docs;
  }, { timeout: 15_000 });
}

test('a fresh document has no source; renaming a tab renames only the document', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await boot(page);

  expect(await page.evaluate(() => (window as unknown as DocsWindow).docs.activeSource)).toBeNull();
  await expect(page.locator('.doc-tab .doc-tab-badge')).toHaveCount(0);

  await page.evaluate(() => {
    const { docs } = window as unknown as DocsWindow;
    docs.renameTab(docs.activeId, 'Poster draft');
  });
  await expect(page).toHaveTitle(/^Poster draft — BuzzQuill$/);
  expect(await page.evaluate(() => (window as unknown as DocsWindow).docs.activeSource)).toBeNull();
  expect(errors).toEqual([]);
});

test('a session saved by the cloud-backed build restores as an unsaved document, title kept', async ({ page }) => {
  await boot(page);
  // Write a record in the OLD shape (fileHandle + cloudDoc), the way the previous
  // build left it, then reload. It goes under its OWN key — the reload's unload
  // flush rewrites this instance's slot — and is dated newest, so the restore's
  // "most recently written session wins" rule picks it.
  await page.evaluate(async () => {
    const id = 'legacy-build-instance';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><metadata class="svgmaker-state">{"app":"BuzzQuill","version":1,"artboards":[],"activeFrameId":null,"shapes":[],"canvasBg":"#ffffff"}</metadata><g class="svgmaker-doc"><rect id="shape-1" x="20" y="20" width="100" height="60" fill="#39f"/></g></svg>';
    const record = {
      session: {
        tabs: [{
          title: 'Old cloud board', svg, view: null, selection: [],
          fileHandle: null,
          cloudDoc: { id: 'abc-123', name: 'Old cloud board', updatedAt: '2026-01-01T00:00:00Z', category: 'Posters' },
          unsavedDelta: false,
        }],
        activeIndex: 0,
      },
      updatedAt: Date.now() + 60_000,
    };
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('buzzquill-session', 1);
      req.onsuccess = () => {
        const tx = req.result.transaction('session', 'readwrite');
        tx.objectStore('session').put(record, id);
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.reload();
  await boot(page);
  // The restore is async after boot; the tab taking its stored name is the signal.
  await expect(page.locator('.doc-tab.active .doc-tab-name')).toHaveText('Old cloud board');

  const tab = await page.evaluate(() => {
    const { docs } = window as unknown as DocsWindow;
    return { title: docs.active.title, source: docs.activeSource, tabs: docs.tabs.length };
  });
  expect(tab).toEqual({ title: 'Old cloud board', source: null, tabs: 1 });
  await expect(page.locator('.doc-tab .doc-tab-badge.cloud')).toHaveCount(0);
  await expect(page.locator('#drawing-layer #shape-1')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('no account or cloud chrome; local-file chrome stays', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#account-area, #account-btn, #cloud-status')).toHaveCount(0);
  await expect(page.locator('#chrome-actions #discord-link')).toHaveCount(1);

  await page.locator('.menu-trigger', { hasText: 'File' }).click();
  const panel = page.locator('.menu-panel');
  await expect(panel.locator('button[data-action^="cloud."]')).toHaveCount(0);
  await expect(panel.locator('button[data-action="file.save"]')).toBeVisible();
  await expect(panel.locator('#recent-files-trigger')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // The command palette carries no account commands either.
  await expect(page.locator('button[data-action^="account."]')).toHaveCount(0);
});
