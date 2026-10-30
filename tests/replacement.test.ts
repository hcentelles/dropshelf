import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { checkUploads, createUpload, getFile, listExplorer, uploadFile } from '../worker/files';
import { shelf } from '../worker/shelf-client';
import { deleteFilePermanently, restoreFile, trashFile } from '../worker/trash';
import type { Principal, ReplaceFile, SharedFile } from '../shared/types';
import type { UploadMetadata } from '../worker/file-record';
import { database, resetDatabase } from './database';

beforeEach(resetDatabase);
const user: Principal = { id: 'writer', email: 'writer@example.test', label: 'Writer', kind: 'user' };
const other: Principal = { id: 'other-writer', email: 'other@example.test', label: 'Other writer', kind: 'user' };
const approval = (file: SharedFile): ReplaceFile => ({ id: file.id, version: file.version });
const bytes = (value: string) => new TextEncoder().encode(value);
const read = async (file: SharedFile) => (await exports.default.fetch(file.url)).text();

async function put(path: string, content: string, replace?: ReplaceFile, owner = user, targetEnv = env) {
  return uploadFile(targetEnv, owner, {
    uploadId: await createUpload(env, owner), path, type: '', body: bytes(content), size: bytes(content).length, source: 'web', replace,
  });
}

it('merges folders across batches and requires confirmation for the full shared path', async () => {
  const file = await put('site/index.html', 'Original');
  await put('site/assets/style.css', 'body { color: green; }', undefined, other);
  const root = await listExplorer(env, null);
  expect(root.total).toBe(1);
  expect(root.entries[0]).toMatchObject({ kind: 'folder', path: 'site', fileCount: 2, uploaderLabel: 'Multiple users' });
  expect((await listExplorer(env, null, 30, 'files', { folder: 'site' })).entries.map(item => item.name)).toEqual(['assets', 'index.html']);
  expect(await checkUploads(env, ['site/index.html', 'another/index.html'])).toEqual([
    { path: 'site/index.html', existing: file }, { path: 'another/index.html' },
  ]);
  await expect(put(file.path, 'Unconfirmed', undefined, other)).rejects.toMatchObject({ status: 409, details: { conflict: { id: file.id, version: 1 } } });
  expect(await read(file)).toBe('Original');
});

it('keeps the file identity and URLs when another member confirms a replacement', async () => {
  const file = await put('site/page.html', 'Original');
  const replacement = await put(file.path, 'Replacement contents', approval(file), other);
  expect(replacement).toMatchObject({ id: file.id, uploadId: file.uploadId, url: file.url, downloadUrl: file.downloadUrl,
    createdAt: file.createdAt, version: 2, size: 20, uploaderEmail: other.email });
  expect(replacement.updatedAt).toBeGreaterThanOrEqual(file.updatedAt);
  expect(await read(file)).toBe('Replacement contents');
  await evictDurableObject(shelf(env));
  expect((await getFile(env, file.id)).version).toBe(2);
  expect(await read(file)).toBe('Replacement contents');
});

it('resolves relative assets added in later batches and preserves their links on replacement', async () => {
  const html = await put('site/index.html', '<script src="assets/app.js"></script>');
  const script = await put('site/assets/app.js', 'const version = 1;');
  const relative = new URL('assets/app.js', html.url).href;
  expect(await (await exports.default.fetch(relative)).text()).toBe('const version = 1;');
  await put(script.path, 'const version = 2;', approval(script));
  expect(await (await exports.default.fetch(relative)).text()).toBe('const version = 2;');
  expect(await read(script)).toBe('const version = 2;');
});

it('rejects stale confirmation and allows only one concurrent replacement of a version', async () => {
  const file = await put('page.html', 'Original');
  const results = await Promise.allSettled([
    put(file.path, 'First writer', approval(file)), put(file.path, 'Second writer', approval(file), other),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const current = await getFile(env, file.id);
  expect(current.version).toBe(2);
  const contents = await read(current);
  await expect(put(file.path, 'Stale writer', approval(file))).rejects.toMatchObject({ status: 409, details: { conflict: { version: 2 } } });
  expect(await read(file)).toBe(contents);
  expect(await database(sql => sql.exec("SELECT id FROM upload_writes WHERE state = 'uploading'").toArray())).toEqual([]);
});

it('serves the old bytes until replacement commits and blocks Trash during that upload', async () => {
  const file = await put('page.html', 'Original');
  let resume!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const writing = new Promise<void>(resolve => { started = resolve; });
  const slowEnv = { ...env, FILES: {
    put: async (key: string, body: Uint8Array) => { await env.FILES.put(key, body); started(); await gate; },
    delete: (key: string) => env.FILES.delete(key),
  } as unknown as R2Bucket };
  const pending = put(file.path, 'New contents', approval(file), user, slowEnv);
  await writing;
  try {
    expect(await read(file)).toBe('Original');
    await expect(trashFile(env, user, file.id)).rejects.toMatchObject({ status: 409 });
    await expect(put(file.path, 'Another writer', approval(file))).rejects.toMatchObject({ status: 409 });
  } finally { resume(); }
  await pending;
  expect(await read(file)).toBe('New contents');
});

it('keeps the old file when R2 fails after writing the staged replacement', async () => {
  const file = await put('page.html', 'Original');
  let stagedKey = '';
  const failingEnv = { ...env, FILES: {
    put: async (key: string, body: Uint8Array) => { stagedKey = key; await env.FILES.put(key, body); throw new Error('Upload failed'); },
    delete: (key: string) => env.FILES.delete(key),
  } as unknown as R2Bucket };
  await expect(put(file.path, 'Failed replacement', approval(file), user, failingEnv)).rejects.toThrow('Upload failed');
  expect(await env.FILES.head(stagedKey)).toBeNull();
  expect(await getFile(env, file.id)).toEqual(file);
  expect(await read(file)).toBe('Original');
  expect((await put(file.path, 'Successful retry', approval(file))).url).toBe(file.url);
});

it('recovers a committed replacement after its RPC response is lost', async () => {
  const file = await put('page.html', 'Original');
  const stub = shelf(env);
  const failingEnv = { ...env, SHELF: { getByName: () => ({
    reserveUpload: (owner: Principal, input: UploadMetadata) => stub.reserveUpload(owner, input),
    completeUpload: async (id: string) => { await stub.completeUpload(id); throw new Error('Lost response'); },
    abortUpload: (id: string) => stub.abortUpload(id),
    completedUpload: (id: string) => stub.completedUpload(id),
  }) } as unknown as Env['SHELF'] };
  const result = await put(file.path, 'Committed', approval(file), user, failingEnv);
  expect(result).toMatchObject({ id: file.id, version: 2, url: file.url });
  expect(await read(file)).toBe('Committed');
});

it('cleans retired bytes and expired uploads without removing the active file', async () => {
  const file = await put('page.html', 'Original');
  const oldKey = await database(sql => sql.exec<{ object_key: string }>('SELECT object_key FROM files WHERE id = ?', file.id).one().object_key);
  const current = await put(file.path, 'Current', approval(file));
  expect(await env.FILES.head(oldKey)).not.toBeNull();
  const uploadId = await createUpload(env, user);
  const pending = await shelf(env).reserveUpload(user, { uploadId, path: file.path, contentType: 'text/html', size: 4, source: 'web', replace: approval(current) });
  await env.FILES.put(pending.object_key, 'Late');
  await database(sql => { sql.exec("UPDATE upload_writes SET expires_at = 0 WHERE state = 'uploading'"); });
  await runInDurableObject(shelf(env), instance => instance.alarm());
  await expect((async () => shelf(env).completeUpload(pending.id))()).rejects.toMatchObject({ status: 409 });
  await database(sql => { sql.exec('UPDATE retired_objects SET delete_after = 0'); });
  await runInDurableObject(shelf(env), instance => instance.alarm());
  expect(await env.FILES.head(oldKey)).toBeNull();
  expect(await env.FILES.head(pending.object_key)).toBeNull();
  expect(await read(file)).toBe('Current');
});

it('keeps Trash links inactive and refuses restore over a new file at the same path', async () => {
  const file = await put('page.html', 'Original');
  await trashFile(env, user, file.id);
  const current = await put(file.path, 'New file');
  expect(current.url).not.toBe(file.url);
  expect((await exports.default.fetch(file.url)).status).toBe(404);
  await expect(restoreFile(env, file.id)).rejects.toMatchObject({ status: 409 });
  expect(await read(current)).toBe('New file');
  await trashFile(env, user, current.id);
  await restoreFile(env, file.id);
  expect(await read(file)).toBe('Original');
  await deleteFilePermanently(env, current.id, true);
  expect((await exports.default.fetch(current.url)).status).toBe(404);
  expect(await read(file)).toBe('Original');
});

it('rejects file-folder collisions and matches normalized Unicode paths exactly', async () => {
  const file = await put('café/page.html', 'Original');
  await expect(put('cafe\u0301/page.html', 'Duplicate')).rejects.toMatchObject({ status: 409 });
  await expect(put('café/page.html/child.html', 'Child')).rejects.toMatchObject({ status: 409 });
  await put('folder.html/child.html', 'Child');
  await expect(put('folder.html', 'Parent file')).rejects.toMatchObject({ status: 409 });
  const replacement = await put('cafe\u0301/page.html', 'Updated', approval(file));
  expect(replacement.url).toBe(file.url);
});

it('returns HTTP conflict details and requires the exact file version on replacement', async () => {
  const group = await exports.default.fetch('http://localhost:8787/api/uploads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const { uploadId } = await group.json() as { uploadId: string };
  const send = (suffix = '') => exports.default.fetch(`http://localhost:8787/api/uploads/${uploadId}?path=page.html${suffix}`, {
    method: 'PUT', headers: { 'Content-Type': 'text/html', 'Content-Length': '7' }, body: 'Content',
  });
  const first = await (await send()).json() as SharedFile;
  const conflict = await send();
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ conflict: { id: first.id, version: 1 } });
  const changed = await send(`&replaceId=${first.id}&replaceVersion=1`);
  expect(changed.status).toBe(201);
  expect(await changed.json()).toMatchObject({ id: first.id, url: first.url, version: 2 });
  expect((await send(`&replaceId=${first.id}&replaceVersion=1`)).status).toBe(409);
  expect((await send('&replaceVersion=1')).status).toBe(400);
});
