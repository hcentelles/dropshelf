import type { Page } from '@playwright/test';
import type { ExplorerPage, SharedFile } from '../shared/types';
import { DAY_MS } from '../shared/retention';
import { test, expect, fixtureBytes, fixturePath } from './fixtures';
import { downloadBytes, unzip, zipFixture } from './archive';

function row(page: Page, name: string, trash = false) {
  return page.locator(trash ? '#trash-file-list > tr' : '#file-list > tr')
    .filter({ has: page.locator('.file-title').getByText(name, { exact: true }) });
}

async function openTrash(page: Page): Promise<void> {
  await page.locator('.account-menu > summary').click();
  await page.getByRole('link', { name: 'Trash', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible();
}

test('uploads a file, copies its link, and opens the exact contents', async ({ page, app, shelf }) => {
  await page.goto(app.appOrigin);
  await expect(page.getByRole('heading', { name: 'Your shelf is ready' })).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload files', exact: true }).click();
  await (await chooser).setFiles(fixturePath('note.md'));
  await expect(row(page, 'note.md')).toBeVisible();
  await expect(page.locator('#notice-text')).toHaveText('1 file added.');
  const [file] = await shelf.files();
  expect(file).toMatchObject({ name: 'note.md', source: 'web', uploaderEmail: 'e2e@example.test' });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await row(page, 'note.md').getByRole('button', { name: 'Copy link for note.md' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(file!.url);
  const popup = page.waitForEvent('popup');
  await row(page, 'note.md').getByRole('link', { name: 'note.md', exact: true }).click();
  const content = await popup;
  await expect(content).toHaveURL(file!.url);
  await expect(content.locator('body')).toContainText('This file belongs to the local end-to-end test shelf.');
  expect(new URL(content.url()).origin).toBe(app.contentOrigin);
});

test('asks before replacement and keeps the original link', async ({ page, app, shelf, seed }) => {
  await page.goto(app.appOrigin);
  const incoming = { name: seed.alpha.name, mimeType: 'text/markdown', buffer: await fixtureBytes('replacement.md') };
  await page.locator('#file-input').setInputFiles(incoming);
  const dialog = page.getByRole('dialog', { name: 'Replace this file?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#replace-file-path')).toHaveText(seed.alpha.path);
  await dialog.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(page.locator('#notice-text')).toContainText('1 existing file skipped.');
  expect(await (await shelf.http.get(seed.alpha.url)).body()).toEqual(await fixtureBytes('note.md'));
  await expect(page.getByRole('button', { name: 'Upload files', exact: true })).toBeEnabled();
  await page.locator('#file-input').setInputFiles(incoming);
  await dialog.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.locator('#notice-text')).toContainText('1 file replaced.');
  await expect(row(page, seed.alpha.name).getByRole('link', { name: seed.alpha.name, exact: true })).toHaveAttribute('href', seed.alpha.url);
  expect(await (await shelf.http.get(seed.alpha.url)).body()).toEqual(incoming.buffer);
  const files = (await shelf.files()).filter(file => file.path === seed.alpha.path);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ id: seed.alpha.id, url: seed.alpha.url, version: 2 });
});

test('uploads folders, renders relative assets, and downloads a complete ZIP', async ({ page, app, shelf }) => {
  await page.goto(app.appOrigin);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Select folder', exact: true }).click();
  await (await chooser).setFiles(fixturePath('site'));
  await expect(row(page, 'site')).toBeVisible();
  await expect(page.locator('#notice-text')).toHaveText('5 files added. 1 unsupported file skipped.');
  await expect(page.locator('#file-list > tr')).toHaveCount(1);
  await row(page, 'site').getByRole('link', { name: 'site', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Folder path' })).toContainText('site');
  await expect(row(page, 'nested')).toBeVisible();
  const popup = page.waitForEvent('popup');
  await row(page, 'index.html').getByRole('link', { name: 'index.html', exact: true }).click();
  const content = await popup;
  await expect(content.getByRole('heading', { name: 'Ready for local review' })).toHaveCSS('color', 'rgb(36, 93, 197)');
  await expect.poll(() => content.getByAltText('A blue square').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64);
  await content.getByRole('button', { name: 'Check page script' }).click();
  await expect(content.getByRole('status')).toHaveText('The external page script works.');
  expect(new URL(content.url()).origin).toBe(app.contentOrigin);
  expect((await shelf.http.get(`${app.contentOrigin}/api/config`)).status()).toBe(404);
  await content.getByRole('link', { name: 'Open nested notes' }).click();
  await expect(content.locator('body')).toContainText('Folder uploads must keep this relative path.');
  await page.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'All files' }).click();
  await row(page, 'site').getByLabel('More options for site').click();
  const download = page.waitForEvent('download');
  await row(page, 'site').getByRole('link', { name: 'Download folder as ZIP' }).click();
  const archive = await download;
  expect(archive.suggestedFilename()).toBe('site.zip');
  const files = await unzip(await downloadBytes(archive));
  expect(Object.keys(files).sort()).toEqual([
    'site/images/sample.svg', 'site/index.html', 'site/nested/notes.md', 'site/scripts/site.js', 'site/styles/site.css',
  ]);
  for (const [path, bytes] of Object.entries(files)) expect(bytes).toEqual(await fixtureBytes(path));
});

test('uploads ZIP bytes without extraction and rejects an oversized file', async ({ page, app, shelf }) => {
  await page.goto(app.appOrigin);
  const bytes = await zipFixture();
  await page.locator('#file-input').setInputFiles({ name: 'bundle.zip', mimeType: 'application/zip', buffer: bytes });
  await expect(row(page, 'bundle.zip')).toBeVisible();
  const [file] = await shelf.files();
  expect(file!.contentType).toBe('application/zip');
  await row(page, 'bundle.zip').getByLabel('More options for bundle.zip').click();
  const downloaded = page.waitForEvent('download');
  await row(page, 'bundle.zip').getByRole('link', { name: 'Download file', exact: true }).click();
  expect(await downloadBytes(await downloaded)).toEqual(bytes);
  await page.locator('#file-input').setInputFiles({ name: 'too-large.md', mimeType: 'text/markdown', buffer: Buffer.alloc(app.config.maxFileBytes + 1, 65) });
  await expect(page.locator('#notice-text')).toContainText('File is too large.');
  await expect(page.locator('#file-list > tr')).toHaveCount(1);
  expect(await shelf.files()).toHaveLength(1);
});

test('sorts the folder list and combines search, type, and author filters', async ({ page, app, seed }) => {
  await page.goto(app.appOrigin);
  await page.locator('#sort').selectOption('name');
  await expect(page.locator('#file-list .file-title > a')).toHaveText(['site', 'alpha.md', 'zulu.csv']);
  await page.locator('#search').fill('zulu');
  await page.locator('#filter-type').selectOption('text/csv');
  await page.locator('#filter-author').selectOption('local-developer');
  await expect(page.locator('#file-list > tr')).toHaveCount(1);
  await expect(row(page, seed.zulu.name)).toBeVisible();
  await page.locator('#search').fill('missing-fixture');
  await expect(page.getByRole('heading', { name: 'No matching items' })).toBeVisible();
  await page.locator('#clear-filters').click();
  await expect(page.locator('#file-list > tr')).toHaveCount(3);
});

test('shows expiry on demand and supports bulk Trash, restore, and confirmed deletion', async ({ page, app, shelf, seed }) => {
  await page.goto(app.appOrigin);
  const alpha = row(page, seed.alpha.name);
  await expect(alpha.getByRole('tooltip')).toBeHidden();
  await alpha.getByRole('button', { name: /Show expiry for alpha\.md/ }).focus();
  await expect(alpha.getByRole('tooltip')).toContainText('30 days');
  await alpha.getByRole('button', { name: /Show expiry for alpha\.md/ }).press('Escape');
  await expect(alpha.getByRole('tooltip')).toBeHidden();
  await alpha.getByRole('checkbox').check();
  await row(page, seed.zulu.name).getByRole('checkbox').check();
  await page.locator('#bulk-trash').click();
  await expect(alpha).toHaveCount(0);
  await expect(row(page, seed.zulu.name)).toHaveCount(0);
  expect((await shelf.http.get(seed.alpha.url)).status()).toBe(404);
  await openTrash(page);
  const trashAlpha = row(page, seed.alpha.name, true);
  await expect(trashAlpha.locator('.col-expiry')).toContainText('7 days');
  await trashAlpha.getByRole('button', { name: 'Restore alpha.md', exact: true }).click();
  await expect(trashAlpha).toHaveCount(0);
  expect(await (await shelf.http.get(seed.alpha.url)).body()).toEqual(await fixtureBytes('note.md'));
  const trashZulu = row(page, seed.zulu.name, true);
  await trashZulu.getByLabel('More options for zulu.csv').click();
  await trashZulu.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this file permanently?' });
  await expect(dialog).toContainText(seed.zulu.name);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(trashZulu).toBeVisible();
  await trashZulu.getByLabel('More options for zulu.csv').click();
  await trashZulu.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trashZulu).toHaveCount(0);
  expect((await shelf.http.get(`/api/files/${seed.zulu.id}`)).status()).toBe(404);
  expect((await shelf.http.get(seed.zulu.url)).status()).toBe(404);
});

test('loads read-only configuration and local MCP setup from the running server', async ({ page, app }) => {
  await page.goto(app.appOrigin);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('.account-menu > summary').click();
    const loaded = page.waitForResponse(response => response.url() === `${app.appOrigin}/api/config` && response.ok());
    await page.getByRole('button', { name: 'Configuration', exact: true }).click();
    await loaded;
    const dialog = page.getByRole('dialog', { name: 'Configuration', exact: true });
    await expect(dialog.locator('#configuration-name')).toHaveText(app.config.name);
    await expect(dialog.locator('#configuration-app-url')).toHaveText(app.appOrigin);
    await expect(dialog.locator('#configuration-content-url')).toHaveText(app.contentOrigin);
    await expect(dialog.locator('#configuration-file-bytes')).toHaveText('1,048,576 bytes');
    await expect(dialog.locator('#configuration-file-days')).toHaveText('30 days');
    await expect(dialog.locator('#configuration-trash-days')).toHaveText('7 days');
    await expect(dialog.locator('input, select, textarea, [contenteditable]')).toHaveCount(0);
    await expect(dialog).not.toContainText('ACCESS_AUD');
    await dialog.getByRole('button', { name: 'Close configuration' }).click();
  }
  await page.getByRole('link', { name: 'Connect MCP', exact: true }).click();
  await expect(page.locator('#mcp-server-url')).toHaveValue(`${app.appOrigin}/mcp`);
  await expect(page.locator('#mcp-local-note')).toBeVisible();
  await expect(page.locator('#mcp-agent-instructions')).toHaveValue(new RegExp(`${app.appOrigin}/mcp`));
});

test('keeps two open pages current after MCP and browser changes', async ({ page, app, mcp }) => {
  const second = await page.context().newPage();
  await Promise.all([page.goto(app.appOrigin), second.goto(app.appOrigin)]);
  await expect(page.getByRole('heading', { name: 'Your shelf is ready' })).toBeVisible();
  await expect(second.getByRole('heading', { name: 'Your shelf is ready' })).toBeVisible();
  const navigations: string[] = [];
  for (const current of [page, second]) current.on('framenavigated', frame => {
    if (frame === current.mainFrame()) navigations.push(frame.url());
  });
  const file = await mcp.call<SharedFile>('upload_file', { path: 'live-update.md', content: '# Live update\n' });
  await expect(row(page, file.name)).toBeVisible();
  await expect(row(second, file.name)).toBeVisible();
  await expect(row(second, file.name).locator('.source-badge')).toHaveText('MCP');
  await row(page, file.name).getByLabel(`More options for ${file.name}`).click();
  await row(page, file.name).getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await expect(row(page, file.name)).toHaveCount(0);
  await expect(row(second, file.name)).toHaveCount(0);
  expect(navigations).toEqual([]);
});

test('keeps folder navigation and Trash expiry usable at phone width', async ({ page, app, seed }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.appOrigin);
  await expect(row(page, seed.alpha.name)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await row(page, 'site').getByRole('link', { name: 'site', exact: true }).click();
  await row(page, 'nested').getByRole('link', { name: 'nested', exact: true }).click();
  await expect(row(page, 'notes.md')).toBeVisible();
  await page.goBack();
  await expect(row(page, 'index.html')).toBeVisible();
  await openTrash(page);
  await expect(row(page, seed.trashed.name, true).locator('.expiry-mobile-summary')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('shows current expiry in a submenu and updates another open page after changes', async ({ page, app, shelf, seed }) => {
  const second = await page.context().newPage();
  await Promise.all([page.goto(app.appOrigin), second.goto(app.appOrigin)]);
  const file = row(page, seed.alpha.name);
  const expiration = file.getByRole('button', { name: 'Expiration', exact: true });
  const submenu = file.getByRole('group', { name: 'Expiration', exact: true });
  await file.getByLabel(`More options for ${seed.alpha.name}`).click();
  await expect(file.getByRole('button', { name: 'Expire in 30 days', exact: true })).toBeHidden();
  await expect(file.getByRole('button', { name: 'Make permanent', exact: true })).toBeHidden();
  await expiration.press('ArrowRight');
  await expect(submenu.locator('.expiry-summary')).toHaveText('30 days left');
  await expect(file.getByRole('button', { name: 'Expire in 30 days', exact: true })).toBeVisible();
  await expect(file.getByRole('button', { name: 'Make permanent', exact: true })).toBeVisible();
  await expect(file.getByRole('button', { name: 'Back to file options' })).toBeFocused();
  await file.getByRole('button', { name: 'Back to file options' }).press('Escape');
  await expect(expiration).toBeFocused();
  await expect(file.getByRole('button', { name: 'Move to Trash', exact: true })).toBeVisible();
  await expiration.press('Enter');
  await file.getByRole('button', { name: 'Back to file options' }).press('ArrowLeft');
  await expect(expiration).toBeFocused();
  await expiration.click();
  await file.getByRole('button', { name: 'Make permanent', exact: true }).click();
  await expect(file.locator('.permanent-badge')).toHaveText('Permanent');
  await expect(row(second, seed.alpha.name).locator('.permanent-badge')).toHaveText('Permanent');
  await file.getByRole('button', { name: /Show expiry for alpha\.md/ }).focus();
  await expect(file.getByRole('tooltip')).toContainText('Never expires');
  await file.getByRole('button', { name: /Show expiry for alpha\.md/ }).press('Escape');
  await page.reload();
  await expect(file.locator('.permanent-badge')).toBeVisible();
  const before = Date.now();
  await file.getByLabel(`More options for ${seed.alpha.name}`).click();
  await expiration.click();
  await expect(submenu.locator('.expiry-summary')).toHaveText('Never expires');
  await expect(file.getByRole('button', { name: 'Expire in 30 days', exact: true })).toBeVisible();
  await expect(file.getByRole('button', { name: 'Make permanent', exact: true })).toHaveCount(0);
  await file.getByRole('button', { name: 'Back to file options' }).click();
  await expect(expiration).toBeFocused();
  await expiration.click();
  await file.getByRole('button', { name: 'Expire in 30 days', exact: true }).click();
  await expect(file.locator('.permanent-badge')).toHaveCount(0);
  await expect(row(second, seed.alpha.name).locator('.permanent-badge')).toHaveCount(0);
  const response = await shelf.http.get('/api/explorer');
  const entry = (await response.json() as ExplorerPage).entries.find(item => item.id === seed.alpha.id)!;
  expect(entry.expiry!.firstAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
  expect(entry.expiry!.lastAt).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
  expect(await (await shelf.http.get(`/api/files/${seed.alpha.id}`)).json()).toEqual(seed.alpha);
  await file.getByLabel(`More options for ${seed.alpha.name}`).click();
  await expiration.click();
  await expect(submenu.locator('.expiry-summary')).toHaveText('30 days left');
  await expect(file.getByRole('button', { name: 'Make permanent', exact: true })).toBeVisible();
  await page.getByRole('heading', { name: 'All files', exact: true }).click();
  await expect(submenu).toBeHidden();
  await file.getByLabel(`More options for ${seed.alpha.name}`).click();
  await expect(expiration).toBeVisible();
  await expect(submenu).toBeHidden();
  await expiration.press('Escape');
  await expect(file.getByLabel(`More options for ${seed.alpha.name}`)).toBeFocused();
  await second.close();
});

test('applies folder expiry to hidden descendants and future uploads', async ({ page, app, shelf, seed }) => {
  const marked = await shelf.http.post('/api/files/retention', { data: { id: seed.page.id, mode: 'permanent' } });
  expect(marked.ok()).toBe(true);
  await page.goto(app.appOrigin);
  await expect(row(page, 'site').locator('.permanent-badge')).toHaveText('Some permanent');
  await page.locator('#search').fill('index');
  await expect(page.locator('#file-list > tr')).toHaveCount(1);
  await row(page, 'site').getByLabel('More options for site').click();
  await row(page, 'site').getByRole('button', { name: 'Expiration', exact: true }).click();
  await expect(row(page, 'site').locator('.expiry-menu .expiry-summary')).toHaveText('30 days left');
  await expect(row(page, 'site').locator('.expiry-menu .expiry-detail')).toHaveText('Some files are permanent');
  await row(page, 'site').getByRole('button', { name: 'Make permanent', exact: true }).click();
  await expect(row(page, 'site').locator('.permanent-badge')).toHaveText('Permanent');
  await page.locator('#clear-filters').click();
  await row(page, 'site').getByRole('link', { name: 'site', exact: true }).click();
  await expect(row(page, 'nested').locator('.permanent-badge')).toHaveText('Permanent');
  await expect(row(page, 'index.html').locator('.permanent-badge')).toHaveText('Permanent');
  const later = await shelf.upload('site/later.md', Buffer.from('# Later upload\n'));
  await expect(row(page, later.name).locator('.permanent-badge')).toHaveText('Permanent');
  await page.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'All files' }).click();
  await row(page, 'site').getByLabel('More options for site').click();
  await row(page, 'site').getByRole('button', { name: 'Expiration', exact: true }).click();
  await expect(row(page, 'site').locator('.expiry-menu .expiry-summary')).toHaveText('Never expires');
  await expect(row(page, 'site').getByRole('button', { name: 'Make permanent', exact: true })).toHaveCount(0);
  await row(page, 'site').getByRole('button', { name: 'Expire in 30 days', exact: true }).click();
  await expect(row(page, 'site').locator('.permanent-badge')).toHaveCount(0);
  await row(page, 'site').getByRole('link', { name: 'site', exact: true }).click();
  await expect(row(page, 'index.html')).toBeVisible();
  await expect(page.locator('#file-list .permanent-badge')).toHaveCount(0);
  await row(page, 'nested').getByRole('link', { name: 'nested', exact: true }).click();
  await expect(row(page, 'notes.md')).toBeVisible();
  await expect(row(page, 'notes.md').locator('.permanent-badge')).toHaveCount(0);
});

test('shows permanent marks and single-line menu actions at phone width', async ({ page, app, seed }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.appOrigin);
  for (const name of [seed.alpha.name, 'site']) {
    const item = row(page, name);
    await item.getByLabel(`More options for ${name}`).click();
    await item.getByRole('button', { name: 'Expiration', exact: true }).click();
    await expect(item.locator('.expiry-menu .expiry-summary')).toHaveText('30 days left');
    await expect(item.getByRole('group', { name: 'Expiration', exact: true })).toBeInViewport();
    for (const label of ['Expire in 30 days', 'Make permanent']) {
      const action = item.getByRole('button', { name: label, exact: true });
      await expect(action).toBeVisible();
      expect(await action.locator('span').evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(24);
    }
    await item.getByRole('button', { name: 'Make permanent', exact: true }).click();
    await expect(item.locator('.permanent-badge')).toHaveText('Permanent');
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
