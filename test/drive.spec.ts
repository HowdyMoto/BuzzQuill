import { test, expect, type Page } from '@playwright/test';

/**
 * Google Drive open/save (ui/drive.ts) with every Google endpoint stubbed:
 * `page.route` serves fake Identity Services and Picker scripts (the CSP allows
 * those hosts, so the stubs load like the real thing) and answers googleapis.com
 * from fixtures, recording each request. Nothing real is ever called.
 *
 * Needs a dev server built with the Drive env vars (playwright.config.ts sets
 * placeholders on the server it starts; a reused local server has whatever
 * .env.local says) — the suite skips itself otherwise.
 */

const FIXTURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><metadata class="svgmaker-state">{"app":"BuzzQuill","version":1,"artboards":[],"activeFrameId":null,"shapes":[],"canvasBg":"#ffffff"}</metadata><g class="svgmaker-doc"><rect id="shape-1" x="20" y="20" width="100" height="60" fill="#39f"/></g></svg>';

const GSI_STUB = `
  window.google = window.google || {};
  window.google.accounts = { oauth2: {
    initTokenClient(cfg) { return { requestAccessToken() { setTimeout(() => cfg.callback({ access_token: 'tok', expires_in: 3600 }), 0); } }; },
    revoke(t, cb) { window.__revoked = t; if (cb) cb({ successful: true }); },
  } };`;

const PICKER_STUB = `
  window.gapi = { load(name, cb) { setTimeout(cb, 0); } };
  window.google = window.google || {};
  window.google.picker = {
    Action: { PICKED: 'picked', CANCEL: 'cancel', LOADED: 'loaded' },
    ViewId: { DOCS: 'all' },
    DocsView: class { setMimeTypes() { return this; } setIncludeFolders() { return this; } },
    PickerBuilder: class {
      setDeveloperKey() { return this; } setAppId() { return this; } setOAuthToken() { return this; }
      addView() { return this; } setTitle() { return this; } setCallback(cb) { this.cb = cb; return this; }
      build() { const cb = this.cb; return { setVisible(v) { if (v) setTimeout(() => cb({ action: 'picked', docs: [{ id: 'f1', name: 'Pick.svg', mimeType: 'image/svg+xml' }] }), 0); }, dispose() {} }; }
    },
  };`;

interface Call { method: string; url: string; body: string }
interface DriveMock {
  calls: Call[];
  /** What Drive reports as the file's current modifiedTime (conflict = differs from the open baseline 'T1'). */
  serverModified: string;
  patchStatus: number;
  waitForWrite?: Promise<void>;
  folderId?: string;
  folderStatus?: number;
}

async function mockGoogle(page: Page): Promise<DriveMock> {
  const mock: DriveMock = { calls: [], serverModified: 'T1', patchStatus: 200, folderId: 'folder-existing' };
  await page.route('https://accounts.google.com/**', (r) =>
    r.request().url().includes('/gsi/client')
      ? r.fulfill({ contentType: 'application/javascript', body: GSI_STUB })
      : r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://apis.google.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: PICKER_STUB }));
  await page.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const url = req.url(), method = req.method();
    mock.calls.push({ method, url, body: req.postData() ?? '' });
    const file = (over: Partial<Record<string, string>> = {}) => ({ id: 'f1', name: 'Pick.svg', mimeType: 'image/svg+xml', modifiedTime: mock.serverModified, ...over });
    if (method === 'GET' && new URL(url).pathname === '/drive/v3/files') {
      return route.fulfill({ json: { files: mock.folderId ? [{ id: mock.folderId }] : [] } });
    }
    if (method === 'POST' && new URL(url).pathname === '/drive/v3/files') {
      if (mock.folderStatus) return route.fulfill({ status: mock.folderStatus, json: { error: { message: 'Folder creation denied' } } });
      mock.folderId = 'folder-created';
      return route.fulfill({ json: { id: mock.folderId } });
    }
    if (method === 'GET' && url.includes('alt=media')) return route.fulfill({ contentType: 'image/svg+xml', body: FIXTURE_SVG });
    if (method === 'GET' && url.includes('/files/f1')) return route.fulfill({ json: file() });
    if (method === 'PATCH') {
      await mock.waitForWrite;
      if (mock.patchStatus !== 200) return route.fulfill({ status: mock.patchStatus, json: { error: { message: 'Invalid Credentials' } } });
      return route.fulfill({ json: file({ modifiedTime: 'T2' }) });
    }
    if (method === 'POST') {
      await mock.waitForWrite;
      const name = /"name":"([^"]+)"/.exec(req.postData() ?? '')?.[1] ?? 'Untitled.svg';
      return route.fulfill({ json: { id: 'new1', name, mimeType: 'image/svg+xml', modifiedTime: 'T1' } });
    }
    return route.fulfill({ status: 404, json: { error: { message: 'File not found' } } });
  });
  return mock;
}

type W = Window & {
  state: { dirty: boolean; selectShape(id: string): void; setSelectionOpacity(v: number, commit: boolean): void };
  docs: { tabs: { source: unknown }[]; active: { title: string; source: { kind?: string; fileId?: string; modifiedTime?: string } | null } };
};

async function boot(page: Page): Promise<boolean> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  (page as Page & { __errors?: string[] }).__errors = errors;
  await page.goto('/');
  await page.waitForFunction(() => { const w = window as unknown as Partial<W>; return !!w.state && !!w.docs; }, { timeout: 15_000 });
  return (await page.locator('.menu-panel button[data-action="drive.open"]').count()) > 0;
}
const errorsOf = (page: Page) => (page as Page & { __errors?: string[] }).__errors ?? [];

async function fileMenu(page: Page, action: string) {
  await page.locator('.menu-trigger', { hasText: 'File' }).click();
  await page.locator(`.menu-panel button[data-action="${action}"]`).click();
}

async function openFromDrive(page: Page) {
  await fileMenu(page, 'drive.open');
  // openDocument names the tab AFTER load finishes — that's the "it's open" signal.
  await expect(page.locator('.doc-tab.active .doc-tab-name')).toHaveText('Pick.svg');
  await expect(page.locator('#drawing-layer #shape-1')).toHaveCount(1);
}

/** Make the document dirty through the model (a real edit, one undo step). */
async function dirty(page: Page) {
  await page.evaluate(() => { const { state } = window as unknown as W; state.selectShape('shape-1'); state.setSelectionOpacity(0.5, true); });
  expect(await page.evaluate(() => (window as unknown as W).state.dirty)).toBe(true);
}

test.describe('Google Drive', () => {
  test('open from Drive lands in a new tab with a drive source and badge', async ({ page }) => {
    const mock = await mockGoogle(page);
    test.skip(!(await boot(page)), 'dev server has no VITE_GOOGLE_* — Drive is hidden');

    await openFromDrive(page);
    const active = await page.evaluate(() => { const { docs } = window as unknown as W; return { title: docs.active.title, source: docs.activeSource, tabs: docs.tabs.length }; });
    expect(active.title).toBe('Pick.svg');
    expect(active.source).toEqual({ kind: 'drive', fileId: 'f1', name: 'Pick.svg', modifiedTime: 'T1' });
    expect(active.tabs).toBe(1); // the pristine boot tab was reused, like File ▸ Open
    await expect(page.locator('.doc-tab.active .doc-tab-badge.drive')).toHaveCount(1);
    expect(mock.calls.filter((c) => c.url.includes('alt=media'))).toHaveLength(1);
    // Picked file is remembered in the Drive recents popout.
    await page.locator('.menu-trigger', { hasText: 'File' }).click();
    await expect(page.locator('#drive-recent-list button', { hasText: 'Pick.svg' })).toHaveCount(1);
    await page.keyboard.press('Escape');
    expect(errorsOf(page)).toEqual([]);
  });

  test('Save writes the document back to Drive and clears the dirty state', async ({ page }) => {
    const mock = await mockGoogle(page);
    test.skip(!(await boot(page)), 'dev server has no VITE_GOOGLE_* — Drive is hidden');
    await openFromDrive(page);
    await dirty(page);

    await fileMenu(page, 'file.save');
    await expect(page.locator('.toast.success', { hasText: 'to Google Drive' }).last()).toBeVisible();
    await expect(page.locator('#drive-status')).toHaveText('');
    const patch = mock.calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect(patch!.url).toContain('/upload/drive/v3/files/f1?uploadType=multipart');
    expect(patch!.body).toContain('Content-Type: image/svg+xml');
    expect(patch!.body).toContain('<svg');
    expect(patch!.body).toContain('opacity'); // the edit made it into the upload
    const after = await page.evaluate(() => { const w = window as unknown as W; return { dirty: w.state.dirty, modified: w.docs.activeSource?.modifiedTime }; });
    expect(after).toEqual({ dirty: false, modified: 'T2' }); // new baseline for the next conflict check
    expect(errorsOf(page)).toEqual([]);
  });

  test('a file changed in Drive since it was opened asks before overwriting', async ({ page }) => {
    const mock = await mockGoogle(page);
    test.skip(!(await boot(page)), 'dev server has no VITE_GOOGLE_* — Drive is hidden');
    await openFromDrive(page);
    await dirty(page);
    mock.serverModified = 'T9'; // someone else saved meanwhile

    await fileMenu(page, 'file.save');
    const dlg = page.locator('.modal-dialog', { hasText: 'Changed in Google Drive' });
    await expect(dlg).toBeVisible();
    expect(mock.calls.some((c) => c.method === 'PATCH')).toBe(false); // nothing written yet
    await dlg.locator('button', { hasText: 'Keep editing' }).click();
    await expect(dlg).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as W).state.dirty)).toBe(true);
    expect(mock.calls.some((c) => c.method === 'PATCH')).toBe(false);

    // Overwrite path: the write goes through without the precheck.
    await fileMenu(page, 'file.save');
    await page.locator('.modal-dialog button', { hasText: 'Overwrite' }).click();
    await expect(page.locator('.toast.success', { hasText: 'to Google Drive' }).last()).toBeVisible();
    await expect(page.locator('#drive-status')).toHaveText('');
    expect(mock.calls.some((c) => c.method === 'PATCH')).toBe(true);
    expect(await page.evaluate(() => (window as unknown as W).state.dirty)).toBe(false);
    expect(errorsOf(page)).toEqual([]);
  });

  test('a rejected token keeps the document dirty and offers to reconnect', async ({ page }) => {
    const mock = await mockGoogle(page);
    test.skip(!(await boot(page)), 'dev server has no VITE_GOOGLE_* — Drive is hidden');
    await openFromDrive(page);
    await dirty(page);
    mock.patchStatus = 401;

    await fileMenu(page, 'file.save');
    await expect(page.locator('#drive-status')).toHaveText('Reconnect Google Drive');
    expect(await page.evaluate(() => (window as unknown as W).state.dirty)).toBe(true);
    await expect(page.locator('.toast', { hasText: 'Connect Google Drive' })).toBeVisible();
    // The only console noise is the browser's own log line for the deliberate 401.
    expect(errorsOf(page).filter((e) => !/status of 401/.test(e))).toEqual([]);
  });

  test('Save to Google Drive… creates a file that becomes the document\'s source', async ({ page }) => {
    const mock = await mockGoogle(page);
    test.skip(!(await boot(page)), 'dev server has no VITE_GOOGLE_* — Drive is hidden');

    await fileMenu(page, 'drive.save-as');
    const dlg = page.locator('.modal-dialog', { hasText: 'Save to Google Drive' });
    await expect(dlg).toBeVisible();
    await dlg.locator('input').fill('Poster');
    await dlg.locator('button', { hasText: 'Save' }).click();
    await expect(page.locator('.toast.success', { hasText: 'to Google Drive' }).last()).toBeVisible();
    await expect(page.locator('#drive-status')).toHaveText('');
    const post = mock.calls.find((c) => c.method === 'POST');
    expect(post!.url).toContain('/upload/drive/v3/files?uploadType=multipart');
    expect(post!.body).toContain('"name":"Poster.svg"');
    expect(post!.body).toContain('"parents":["folder-existing"]');
    const src = await page.evaluate(() => (window as unknown as W).docs.activeSource);
    expect(src).toEqual({ kind: 'drive', fileId: 'new1', name: 'Poster.svg', modifiedTime: 'T1' });
    await expect(page).toHaveTitle(/^Poster\.svg — BuzzQuill$/);
    await expect(page.locator('.doc-tab.active .doc-tab-badge.drive')).toHaveCount(1);
    expect(errorsOf(page)).toEqual([]);
  });

  test('the Drive source survives a reload through the session store', async ({ page }) => {
    await mockGoogle(page);
    test.skip(!(await boot(page)), 'dev server has no VITE_GOOGLE_* — Drive is hidden');
    await openFromDrive(page);
    // Let the debounced session save land, then come back.
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForFunction(() => { const w = window as unknown as Partial<W>; return !!w.state && !!w.docs; }, { timeout: 15_000 });
    // The restore is async after boot; the tab taking its stored name is the signal.
    await expect(page.locator('.doc-tab.active .doc-tab-name')).toHaveText('Pick.svg');
    const src = await page.evaluate(() => (window as unknown as W).docs.activeSource);
    expect(src).toEqual({ kind: 'drive', fileId: 'f1', name: 'Pick.svg', modifiedTime: 'T1' });
    await expect(page.locator('.doc-tab.active .doc-tab-badge.drive')).toHaveCount(1);
  });
});

test('without Drive configured there is no Drive chrome at all', async ({ page }) => {
  test.skip(await boot(page), 'this server HAS Drive configured');
  await expect(page.locator('button[data-action^="drive."]')).toHaveCount(0);
  await expect(page.locator('#drive-status, #drive-recent-trigger')).toHaveCount(0);
});

for (const expired of [false, true]) {
  test(`Disconnect after reload revokes ${expired ? 'expired' : 'fresh'} cached credentials`, async ({ page }) => {
    await mockGoogle(page);
    test.skip(!(await boot(page)), 'Drive not configured');
    await openFromDrive(page);
    if (expired) await page.evaluate(() => {
      const raw = JSON.parse(sessionStorage.getItem('bq-drive-token')!);
      raw.expiresAt = Date.now() - 1000;
      sessionStorage.setItem('bq-drive-token', JSON.stringify(raw));
    });
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as W).docs);
    await page.locator('.menu-trigger', { hasText: 'Help' }).click();
    await page.locator('[data-action="drive.disconnect"]').click();
    await expect(page.locator('.toast', { hasText: 'access revoked' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('bq-drive-token'))).toBeNull();
    expect(await page.evaluate(() => (window as unknown as { __revoked: string }).__revoked)).toBe('tok');
  });
}

test('Failed revocation reports local disconnect without claiming access was revoked', async ({ page }) => {
  await mockGoogle(page);
  test.skip(!(await boot(page)), 'Drive not configured');
  await openFromDrive(page);
  await page.route('https://accounts.google.com/**', r => r.fulfill({ contentType: 'application/javascript', body: GSI_STUB.replace('successful: true', 'successful: false') }));
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as W).docs);
  await page.locator('.menu-trigger', { hasText: 'Help' }).click();
  await page.locator('[data-action="drive.disconnect"]').click();
  await expect(page.locator('.toast', { hasText: 'did not confirm revocation' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('bq-drive-token'))).toBeNull();
});

for (const saveAs of [false, true]) {
  test(`Delayed Drive ${saveAs ? 'Save As' : 'Save'} stays attached to the initiating tab`, async ({ page }) => {
    const mock = await mockGoogle(page);
    test.skip(!(await boot(page)), 'Drive not configured');
    await openFromDrive(page);
    await dirty(page);
    let release!: () => void;
    mock.waitForWrite = new Promise<void>(r => { release = r; });
    if (saveAs) {
      await fileMenu(page, 'drive.save-as');
      await page.locator('.modal-dialog input').fill('Saved-A.svg');
      await page.locator('.modal-dialog button', { hasText: /^Save$/ }).click();
    } else await page.keyboard.press('Control+s');
    await expect.poll(() => mock.calls.filter(c => c.method === (saveAs ? 'POST' : 'PATCH')).length).toBe(1);
    await fileMenu(page, 'file.new');
    const before = await page.evaluate(() => {
      const w = window as unknown as W & { docs: { activeId: string; activeSource: unknown } };
      return { id: w.docs.activeId, title: document.title, source: w.docs.activeSource };
    });
    release();
    await expect(page.locator('.toast.success', { hasText: 'to Google Drive' }).last()).toBeVisible();
    const after = await page.evaluate(() => {
      const w = window as unknown as W & { docs: { activeId: string; activeSource: unknown } };
      return { id: w.docs.activeId, title: document.title, source: w.docs.activeSource };
    });
    expect(after).toEqual(before);
    await page.locator('.doc-tab').first().click();
    expect(await page.evaluate(() => (window as unknown as W).state.dirty)).toBe(false);
    expect(await page.evaluate(() => (window as unknown as W).docs.activeSource)).toMatchObject({ kind: 'drive', fileId: saveAs ? 'new1' : 'f1' });
    expect(errorsOf(page)).toEqual([]);
  });
}

test('Editing during a Drive upload remains dirty after completion', async ({ page }) => {
  const mock = await mockGoogle(page);
  test.skip(!(await boot(page)), 'Drive not configured');
  await openFromDrive(page);
  await dirty(page);
  let release!: () => void;
  mock.waitForWrite = new Promise<void>(r => { release = r; });
  await page.keyboard.press('Control+s');
  await expect.poll(() => mock.calls.filter(c => c.method === 'PATCH').length).toBe(1);
  await page.evaluate(() => (window as unknown as W).state.setSelectionOpacity(0.7, true));
  release();
  await expect(page.locator('.toast.success', { hasText: 'to Google Drive' }).last()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as W).state.dirty)).toBe(true);
});

test('Save captures its document before Google sign-in and ignores duplicate saves', async ({ page }) => {
  const mock = await mockGoogle(page);
  await page.route('https://accounts.google.com/gsi/client', r => r.fulfill({
    contentType: 'application/javascript',
    body: GSI_STUB.replace("setTimeout(() => cfg.callback({ access_token: 'tok', expires_in: 3600 }), 0)",
      "window.finishSignIn = () => cfg.callback({ access_token: 'tok', expires_in: 3600 })"),
  }));
  test.skip(!(await boot(page)), 'Drive not configured');
  await page.evaluate(svg => { const w = window as any; w.state.importSVGContent(svg); w.state.saveHistory(); }, FIXTURE_SVG);
  await fileMenu(page, 'drive.save-as');
  await page.waitForFunction(() => !!(window as any).finishSignIn);
  await fileMenu(page, 'drive.save-as');
  await expect(page.locator('.toast', { hasText: 'already being saved' })).toBeVisible();
  await fileMenu(page, 'file.new');
  await page.evaluate(() => (window as any).finishSignIn());
  await page.locator('.modal-dialog input').fill('Original.svg');
  await page.locator('.modal-dialog button', { hasText: /^Save$/ }).click();
  await expect(page.locator('.toast.success', { hasText: 'Original.svg' })).toBeVisible();
  const writes = mock.calls.filter(c => c.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toContain('shape-1');
  expect(await page.evaluate(() => (window as any).docs.activeSource)).toBeNull();
  await page.locator('.doc-tab').first().click();
  expect(await page.evaluate(() => (window as any).docs.activeSource)).toMatchObject({ kind: 'drive', fileId: 'new1' });
  expect(errorsOf(page)).toEqual([]);
});

for (const denied of [false, true]) {
  test(`new Drive saves ${denied ? 'stop when folder creation fails' : 'create and reuse the BuzzQuill folder'}`, async ({ page }) => {
    const mock = await mockGoogle(page);
    mock.folderId = undefined;
    if (denied) mock.folderStatus = 403;
    test.skip(!(await boot(page)), 'Drive not configured');
    const saveAs = async () => {
      await fileMenu(page, 'drive.save-as');
      await page.locator('.modal-dialog input').fill('Folder test.svg');
      await page.locator('.modal-dialog button', { hasText: /^Save$/ }).click();
    };
    await saveAs();
    if (denied) {
      await expect(page.locator('#drive-status')).toHaveText('Not saved to Drive');
      expect(mock.calls.filter(c => c.method === 'POST' && c.url.includes('/upload/'))).toHaveLength(0);
      expect(await page.evaluate(() => (window as any).docs.activeSource)).toBeNull();
      return;
    }
    await expect(page.locator('.doc-tab.active .doc-tab-name')).toHaveText('Folder test.svg');
    await saveAs();
    await expect.poll(() => mock.calls.filter(c => c.method === 'POST' && c.url.includes('/upload/')).length).toBe(2);
    const folders = mock.calls.filter(c => c.method === 'POST' && !c.url.includes('/upload/'));
    expect(folders).toHaveLength(1);
    expect(JSON.parse(folders[0].body)).toEqual({ name: 'BuzzQuill', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] });
    for (const upload of mock.calls.filter(c => c.url.includes('/upload/'))) expect(upload.body).toContain('"parents":["folder-created"]');
    const lookup = mock.calls.find(c => c.method === 'GET' && new URL(c.url).pathname === '/drive/v3/files')!;
    expect(new URL(lookup.url).searchParams.get('q')).toContain("'root' in parents and trashed = false");
  });
}

test('Disconnect blocks Save from reconnecting, including after reload, until explicit Connect', async ({ page }) => {
  const mock = await mockGoogle(page);
  test.skip(!(await boot(page)), 'Drive not configured');
  await openFromDrive(page);
  await dirty(page);
  await page.locator('.menu-trigger', { hasText: 'Help' }).click();
  await page.locator('[data-action="drive.disconnect"]').click();
  await expect(page.locator('.toast', { hasText: 'access revoked' })).toBeVisible();
  for (const reload of [false, true]) {
    if (reload) {
      await page.reload();
      await expect(page.locator('.doc-tab.active .doc-tab-name')).toHaveText('Pick.svg');
    }
    await page.keyboard.press('Control+s');
    await expect(page.locator('#drive-status')).toHaveText('Reconnect Google Drive');
    expect(mock.calls.filter(c => c.method === 'PATCH')).toHaveLength(0);
    expect(await page.evaluate(() => sessionStorage.getItem('bq-drive-token'))).toBeNull();
  }
  await page.locator('.menu-trigger', { hasText: 'Help' }).click();
  await page.locator('[data-action="drive.connect"]').click();
  await expect(page.locator('.toast.success', { hasText: 'Connected to Google Drive' })).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect.poll(() => mock.calls.filter(c => c.method === 'PATCH').length).toBe(1);
  expect(mock.calls.some(c => new URL(c.url).pathname === '/drive/v3/files')).toBe(false);
  expect(mock.calls.find(c => c.method === 'PATCH')!.body).not.toContain('"parents"');
});
