import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js/lib/zip-core-native.js';
import { createUpload, listExplorer, uploadFile } from '../worker/files';
import { trashFile } from '../worker/trash';
import { downloadFolder } from '../worker/archive';
import { folderArchiveFiles, MAX_ARCHIVE_FILES } from '../worker/archive-store';
import worker from '../worker/index';
import { database, prepareDatabase, resetDatabase } from './database';

beforeAll(prepareDatabase);
beforeEach(resetDatabase);
const user = { id: 'archive-user', email: 'archive@example.test', label: 'Archive user', kind: 'user' as const };
const content = 'http://127.0.0.1:8787';
const codecs = { useWebWorkers: false, useCompressionStream: true };

async function add(path: string, text = '<p>Archive test</p>') {
  const body = new TextEncoder().encode(text);
  return uploadFile(env, user, { uploadId: await createUpload(env, user), path, type: '', size: body.length, body, source: 'web' });
}

async function contents(response: Response) {
  const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(await response.arrayBuffer())), codecs);
  const files: Record<string, string> = {};
  const entries = await zip.getEntries();
  for (const entry of entries) {
    if (!entry.directory) files[entry.filename] = await entry.getData(new TextWriter(), { checkSignature: true });
  }
  await zip.close();
  return { files, entries };
}

it('uploads ZIP bytes without extraction, uses the canonical type, and downloads them unchanged', async () => {
  const zip = new ZipWriter(new Uint8ArrayWriter(), codecs);
  await zip.add('inside.html', new TextReader('<h1>In the ZIP</h1>'));
  const body = await zip.close();
  const uploadId = await createUpload(env, user);
  const file = await uploadFile(env, user, { uploadId, path: 'package.ZIP', type: 'image/png', size: body.length, body, source: 'mcp' });
  expect(file.contentType).toBe('application/zip');
  const response = await exports.default.fetch(file.url);
  expect(response.headers.get('Content-Type')).toBe('application/zip');
  expect(response.headers.get('Content-Disposition')).toContain('attachment');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  expect((await listExplorer(env, null)).total).toBe(1);
  await expect(uploadFile({ ...env, ALLOWED_FILE_TYPES: 'image/*' }, user, {
    uploadId, path: 'blocked.zip', type: 'image/png', size: body.length, body, source: 'web',
  })).rejects.toMatchObject({ status: 415 });
});

it('compresses the complete folder across uploads, preserves UTF-8 paths, and excludes Trash and sibling folders', async () => {
  const text = '<h1>A repeated line for compression</h1>\n'.repeat(5_000);
  await add('100%_café/index.html', text);
  await add('100%_café/assets/mañana.css', 'body { color: blue; }');
  await add('100%_café/empty.csv', '');
  await add('100%Xcafé/sibling.html');
  const removed = await add('100%_café/trash.html');
  await trashFile(env, user, removed.id);
  const filtered = await listExplorer(env, null, 1, 'files', { q: 'index.html' });
  const folder = filtered.entries[0]!;
  const response = await exports.default.fetch(folder.downloadUrl);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''100%25_caf%C3%A9.zip");
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  const archive = await contents(response);
  expect(archive.files).toEqual({
    '100%_café/assets/mañana.css': 'body { color: blue; }',
    '100%_café/empty.csv': '', '100%_café/index.html': text,
  });
  const html = archive.entries.find(entry => entry.filename.endsWith('index.html'))!;
  expect(html.compressionMethod).toBe(8);
  expect(html.compressedSize).toBeLessThan(html.uncompressedSize / 10);
  const nested = await contents(await exports.default.fetch(`${content}/folders.zip?path=${encodeURIComponent('100%_café/assets')}`));
  expect(nested.files).toEqual({ 'assets/mañana.css': 'body { color: blue; }' });
});

it('includes all files beyond the first list page', async () => {
  const body = new TextEncoder().encode('<p>Page</p>');
  const key = crypto.randomUUID();
  for (let i = 0; i < 105; i++) await env.FILES.put(`${key}/${i}`, body);
  await database(sql => {
    const uploadId = crypto.randomUUID();
    sql.exec('INSERT INTO uploads VALUES (?, ?, ?)', uploadId, user.id, Date.now());
    for (let i = 0; i < 105; i++) {
      const path = `many/page-${i}.html`;
      sql.exec(`INSERT INTO files (id, upload_id, path, name, object_key, content_type, size, uploader_id, uploader_label, source, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'text/html', ?, ?, ?, 'web', 'ready', ?)`,
      crypto.randomUUID(), uploadId, path, `page-${i}.html`, `${key}/${i}`, body.length, user.id, user.label, Date.now());
    }
  });
  const archive = await contents(await exports.default.fetch(`${content}/folders.zip?path=many`));
  expect(Object.keys(archive.files)).toHaveLength(105);
  expect(archive.files['many/page-104.html']).toBe('<p>Page</p>');
});

it('rejects invalid, missing, and oversized folders before streaming and requires authentication', async () => {
  for (const path of ['', '../escape', '/absolute', 'folder//child', 'C:']) {
    expect((await exports.default.fetch(`${content}/folders.zip?path=${encodeURIComponent(path)}`)).status).toBe(400);
  }
  expect((await exports.default.fetch(`${content}/folders.zip?path=missing`)).status).toBe(404);
  const ctx = createExecutionContext();
  const protectedEnv = { ...env, CONTENT_ORIGIN: 'https://content.example.test', LOCAL_DEV_EMAIL: '',
    ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: 'test-audience' };
  const unauthenticated = await worker.fetch(new Request('https://content.example.test/folders.zip?path=private'), protectedEnv, ctx);
  expect(unauthenticated.status).toBe(401);
  await waitOnExecutionContext(ctx);
  await database(sql => {
    const uploadId = crypto.randomUUID();
    sql.exec('INSERT INTO uploads VALUES (?, ?, ?)', uploadId, user.id, Date.now());
    for (let i = 0; i <= MAX_ARCHIVE_FILES; i++) {
      sql.exec(`INSERT INTO files (id, upload_id, path, name, object_key, content_type, size, uploader_id, uploader_label, source, status, created_at)
        VALUES (?, ?, ?, 'file.html', ?, 'text/html', 0, ?, ?, 'web', 'ready', ?)`,
      crypto.randomUUID(), uploadId, `large/${i}.html`, `${uploadId}/${i}`, user.id, user.label, Date.now());
    }
    expect(() => folderArchiveFiles(sql, 'large')).toThrow('up to 5,000 files');
  });
  expect((await exports.default.fetch(`${content}/folders.zip?path=large`)).status).toBe(413);
});

it('fails the download if a stored file is missing, without returning a partial ZIP', async () => {
  const file = await add('missing-object/page.html');
  const key = await database(sql => sql.exec<{ object_key: string }>('SELECT object_key FROM files WHERE id = ?', file.id).one().object_key);
  await env.FILES.delete(key);
  const ctx = createExecutionContext();
  const response = await downloadFolder(new Request(`${content}/folders.zip?path=missing-object`), env, ctx);
  await expect(response.arrayBuffer()).rejects.toThrow('no longer available');
  await waitOnExecutionContext(ctx);
});

it('stops reading files when the browser cancels the download', async () => {
  await add('cancel/a.html', 'A'.repeat(100_000));
  await add('cancel/b.html');
  const get = vi.fn(env.FILES.get.bind(env.FILES));
  const ctx = createExecutionContext();
  const response = await downloadFolder(new Request(`${content}/folders.zip?path=cancel`), {
    ...env, FILES: { get } as unknown as R2Bucket,
  }, ctx);
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel('Download cancelled.');
  await waitOnExecutionContext(ctx);
  expect(get).toHaveBeenCalledTimes(1);
});
