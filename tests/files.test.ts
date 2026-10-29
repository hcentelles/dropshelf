import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareDatabase, database } from './database';
import type { FilePage, SharedFile } from '../shared/types';
import { createUpload, uploadFile } from '../worker/files';

beforeAll(prepareDatabase);

const app = 'http://localhost:8787';
const content = 'http://127.0.0.1:8787';
const user = { id: 'local-developer', email: 'developer@example.test', label: 'developer@example.test', kind: 'user' as const };
const fetchApp = (path: string, init?: RequestInit) => exports.default.fetch(`${app}${path}`, init);
async function group(): Promise<string> {
  const response = await fetchApp('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(response.status).toBe(201);
  return (await response.json() as { uploadId: string }).uploadId;
}
async function put(uploadId: string, path: string, body = '<!doctype html><h1>Test</h1>', type = 'text/html'): Promise<Response> {
  return fetchApp(`/api/uploads/${uploadId}?path=${encodeURIComponent(path)}`, {
    method: 'PUT', headers: { 'Content-Type': type, 'Content-Length': String(new TextEncoder().encode(body).length) }, body,
  });
}

describe('private file service', () => {
  it('keeps folder paths, records the server identity, and serves HTML inline on the content origin', async () => {
    const id = await group();
    const response = await put(id, 'sample/index.html');
    expect(response.status).toBe(201);
    const file = await response.json() as SharedFile;
    expect(file.uploaderEmail).toBe(user.email);
    expect(file.url).toBe(`${content}/f/${id}/sample/index.html`);
    const page = await exports.default.fetch(file.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toBe('text/html');
    expect(page.headers.get('Content-Disposition')).toContain('inline');
    expect(page.headers.get('Cache-Control')).toBe('private, no-store');
    expect(page.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");
    expect(await page.text()).toContain('<h1>Test</h1>');
    const head = await exports.default.fetch(file.url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const download = await exports.default.fetch(file.downloadUrl);
    expect(download.headers.get('Content-Disposition')).toContain('attachment');
  });

  it('does not accept a forged uploader identity', async () => {
    const response = await fetchApp('/api/uploads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'other@example.test' }),
    });
    expect(response.status).toBe(400);
  });

  it('accepts external CSS and JavaScript at HTML-relative paths with executable MIME types', async () => {
    const id = await group();
    const html = await put(id, 'site/index.html', '<link rel="stylesheet" href="assets/style.css"><script src="assets/app.js"></script>');
    const file = await html.json() as SharedFile;
    for (const [path, body, type] of [
      ['assets/style.css', 'body { color: green; }', 'text/css'],
      ['assets/app.js', 'document.title = "Loaded";', 'text/javascript'],
    ]) {
      expect((await put(id, `site/${path}`, body, type)).status).toBe(201);
      const response = await exports.default.fetch(new URL(path!, file.url).href);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe(type);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(await response.text()).toBe(body);
    }
  });

  it('accepts Markdown and CSV, opens their text in the browser, and keeps original download types', async () => {
    const id = await group();
    for (const [path, body, type] of [
      ['notes.md', '# Review\n\nHello, **team**.\n', 'text/markdown'],
      ['scores.csv', 'name,score\nAda,10\n', 'text/csv'],
    ]) {
      const response = await put(id, path!, body, type);
      expect(response.status).toBe(201);
      const file = await response.json() as SharedFile;
      expect(file.contentType).toBe(type);
      const view = await exports.default.fetch(file.url);
      expect(view.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(await view.text()).toBe(body);
      const original = await exports.default.fetch(file.downloadUrl);
      expect(original.headers.get('Content-Type')).toBe(type);
      expect(await original.text()).toBe(body);
    }
  });

  it('enforces the configured file types on the server even when a client spoofs the MIME type', async () => {
    const id = await createUpload(env, user);
    const imagesOnly = { ...env, ALLOWED_FILE_TYPES: 'image/*' };
    for (const path of ['not-an-image.html', 'notes.md', 'scores.csv']) {
      await expect(uploadFile(imagesOnly, user, {
        uploadId: id, path, type: 'image/png', size: 0, body: new Uint8Array(), source: 'web',
      })).rejects.toMatchObject({ status: 415 });
    }
    const markdownOnly = { ...env, ALLOWED_FILE_TYPES: '.md' };
    const file = await uploadFile(markdownOnly, user, {
      uploadId: id, path: 'allowed.md', type: 'application/octet-stream', size: 0,
      body: new Uint8Array(), source: 'web',
    });
    expect(file.contentType).toBe('text/markdown');
  });

  it('rejects unsupported files and traversal paths', async () => {
    const id = await group();
    expect((await put(id, 'notes.txt', 'not supported', 'text/plain')).status).toBe(415);
    for (const path of ['../secret.html', '/root.html', 'folder//page.html', 'folder\\page.html']) {
      expect((await put(id, path)).status).toBe(400);
    }
  });

  it('does not overwrite an existing file path', async () => {
    const id = await group();
    const first = await put(id, 'page.html', '<p>Original</p>');
    const file = await first.json() as SharedFile;
    expect((await put(id, 'page.html', '<p>Replacement</p>')).status).toBe(409);
    expect(await (await exports.default.fetch(file.url)).text()).toBe('<p>Original</p>');
  });

  it('does not allow one user to add files to another user’s group', async () => {
    const id = await group();
    const other = { ...user, id: 'another-user', email: 'other@example.test', label: 'other@example.test' };
    await expect(uploadFile(env, other, {
      uploadId: id, path: 'page.html', type: 'text/html', size: 0, body: new Uint8Array(), source: 'web',
    })).rejects.toMatchObject({ status: 403 });
  });

  it('rejects oversized files before it reserves a path', async () => {
    const id = await createUpload(env, user);
    await expect(uploadFile(env, user, {
      uploadId: id, path: 'large.png', type: 'image/png', size: Number(env.MAX_FILE_BYTES) + 1,
      body: new Uint8Array(), source: 'web',
    })).rejects.toMatchObject({ status: 413 });
    expect(await database(sql => sql.exec('SELECT id FROM files WHERE upload_id = ?', id).toArray()[0] ?? null)).toBeNull();
  });

  it('rejects cross-site uploads and does not expose the API on the content origin', async () => {
    const response = await fetchApp('/api/uploads', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: content }, body: '{}',
    });
    expect(response.status).toBe(403);
    expect((await exports.default.fetch(`${content}/api/files`)).status).toBe(404);
    expect((await exports.default.fetch('https://unconfigured.example.test/api/files')).status).toBe(403);
  });

  it('keeps SVG and HTML away from the application thumbnail endpoint', async () => {
    const id = await group();
    const response = await put(id, 'vector.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml');
    const file = await response.json() as SharedFile;
    expect((await fetchApp(`/api/files/${file.id}/thumbnail`)).status).toBe(404);
    expect((await fetchApp(`/f/${id}/vector.svg`)).status).toBe(404);
  });

  it('uses stable pagination when new files arrive between pages', async () => {
    const id = await group();
    for (let index = 0; index < 4; index++) expect((await put(id, `page-${index}.html`)).status).toBe(201);
    const first = await (await fetchApp('/api/files?limit=2')).json() as FilePage;
    expect(first.files).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    expect((await put(id, 'new-page.html')).status).toBe(201);
    const second = await (await fetchApp(`/api/files?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)).json() as FilePage;
    expect(second.files).toHaveLength(2);
    const firstIds = new Set(first.files.map(file => file.id));
    expect(second.files.some(file => firstIds.has(file.id))).toBe(false);
    expect(second.files.some(file => file.name === 'new-page.html')).toBe(false);
    expect((await fetchApp('/api/files?cursor=invalid')).status).toBe(400);
  });
});
