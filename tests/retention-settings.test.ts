import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { DAY_MS, type RetentionMode } from '../shared/retention';
import { createUpload, getFile, listExplorer, uploadFile } from '../worker/files';
import { moveExpiredToTrash } from '../worker/retention-store';
import { setRetention } from '../worker/retention-settings';
import { shelf } from '../worker/shelf-client';
import { deleteFilePermanently, restoreFile, trashFile } from '../worker/trash';
import { queryExplorer } from '../worker/explorer';
import { database, resetDatabase } from './database';

beforeEach(resetDatabase);
const user = { id: 'writer', email: 'writer@example.test', label: 'Writer', kind: 'user' as const };
const body = new TextEncoder().encode('Expiry settings test');

async function add(path: string, at = Date.now() - 20 * DAY_MS) {
  const file = await uploadFile(env, user, {
    uploadId: await createUpload(env, user), path, type: '', size: body.length, body, source: 'web',
  });
  await database(sql => { sql.exec('UPDATE files SET created_at = ?, updated_at = ? WHERE id = ?', at, at, file.id); });
  return getFile(env, file.id);
}

const change = (id: string, mode: RetentionMode, now: number) => runInDurableObject(shelf(env),
  (_instance, state) => setRetention(state.storage, id, mode, now));
const expire = (now: number, days = 30) => runInDurableObject(shelf(env),
  (_instance, state) => moveExpiredToTrash(state.storage, days, now));

it('sets 30 days from the action time, not the old deadline, without changing file metadata', async () => {
  const file = await add('extended.md');
  const now = Date.now();
  expect(await change(file.id, '30-days', now)).toEqual({ id: file.id, mode: '30-days', expiresAt: now + 30 * DAY_MS });
  const again = now + 2 * DAY_MS;
  await change(file.id, '30-days', again);
  const entry = (await listExplorer(env, null)).entries[0]!;
  expect(entry).toMatchObject({ permanent: false, expiry: { firstAt: again + 30 * DAY_MS, lastAt: again + 30 * DAY_MS } });
  expect(await getFile(env, file.id)).toEqual(file);
  await evictDurableObject(shelf(env));
  expect(await expire(again + 30 * DAY_MS - 1)).toBe(0);
  expect(await expire(again + 30 * DAY_MS)).toBe(1);
});

it('applies an explicit 30-day period even when the default differs or is disabled', async () => {
  const file = await add('custom-period.md');
  const now = Date.now();
  await change(file.id, '30-days', now);
  for (const fileDays of ['0', '90']) {
    const entry = (await database(sql => queryExplorer(sql, { ...env, FILE_RETENTION_DAYS: fileDays }, null))).entries[0]!;
    expect(entry.expiry).toEqual({ firstAt: now + 30 * DAY_MS, lastAt: now + 30 * DAY_MS });
  }
  expect(await expire(now + 30 * DAY_MS - 1, 0)).toBe(0);
  expect(await expire(now + 30 * DAY_MS, 0)).toBe(1);
});

it('changes a complete nested folder across uploads, filters, and pages without changing its siblings', async () => {
  const now = Date.now();
  const nested = [await add('site/nested/first.md'), await add('site/nested/deeper/second.md')];
  const sibling = await add('site/sibling.md');
  const outside = await add('site/nested-other/third.md');
  await change('folder:site/nested', '30-days', now);
  const first = (await listExplorer(env, null, 1, 'files', { folder: 'site', q: 'first' })).entries[0]!;
  expect(first).toMatchObject({ path: 'site/nested', fileCount: 2, expiry: { firstAt: now + 30 * DAY_MS, lastAt: now + 30 * DAY_MS } });
  expect(await expire(now + 11 * DAY_MS)).toBe(2);
  for (const file of nested) expect((await getFile(env, file.id)).trashedAt).toBeNull();
  for (const file of [sibling, outside]) expect((await getFile(env, file.id)).trashedAt).not.toBeNull();
  expect(await expire(now + 30 * DAY_MS)).toBe(2);
});

it('keeps permanent folders and future uploads, and reports later file exceptions accurately', async () => {
  const page = await add('site/index.html');
  await add('site/assets/image.svg');
  const now = Date.now();
  await change('folder:site', 'permanent', now);
  const later = await add('site/nested/later.md', now + DAY_MS);
  await evictDurableObject(shelf(env));
  expect((await listExplorer(env, null, 1, 'files', { q: 'index' })).entries[0]).toMatchObject({
    path: 'site', permanent: true, permanentCount: 3, expiry: null,
  });
  expect((await listExplorer(env, null, 1, 'files', { folder: 'site/nested' })).entries[0]).toMatchObject({ id: later.id, permanent: true, expiry: null });
  expect(await expire(now + 500 * DAY_MS)).toBe(0);
  await change(page.id, '30-days', now + DAY_MS);
  const mixed = (await listExplorer(env, null, 1, 'files', { q: 'index' })).entries[0]!;
  expect(mixed).toMatchObject({ permanent: false, permanentCount: 2, expiry: { firstAt: now + 31 * DAY_MS, lastAt: now + 31 * DAY_MS } });
  expect(await expire(now + 31 * DAY_MS)).toBe(1);
  expect((await getFile(env, later.id)).trashedAt).toBeNull();
});

it('replaces all descendant settings with a folder action, including more than one page of files', async () => {
  const first = await add('whole/first.md');
  const second = await add('whole/nested/second.md');
  await database(sql => {
    for (let index = 0; index < 35; index++) {
      const id = crypto.randomUUID();
      sql.exec(`INSERT INTO files (id, upload_id, path, name, object_key, content_type, size,
        uploader_id, uploader_label, source, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'text/markdown', 1, 'writer', 'Writer', 'web', 'ready', 0, 0)`,
      id, first.uploadId, `whole/extra-${index}.md`, `extra-${index}.md`, `objects/${id}`);
    }
  });
  const now = Date.now();
  await change(first.id, 'permanent', now);
  await change('folder:whole/nested', 'permanent', now);
  await change('folder:whole', '30-days', now);
  const folder = (await listExplorer(env, null, 1, 'files', { q: 'first' })).entries[0]!;
  expect(folder).toMatchObject({ permanent: false, permanentCount: 0, fileCount: 37,
    expiry: { firstAt: now + 30 * DAY_MS, lastAt: now + 30 * DAY_MS } });
  expect((await listExplorer(env, null, 1, 'files', { folder: 'whole/nested' })).entries[0]).toMatchObject({ id: second.id, permanent: false });
  await change('folder:whole', 'permanent', now + DAY_MS);
  expect(await expire(now + 1000 * DAY_MS)).toBe(0);
  expect((await listExplorer(env, null)).entries[0]).toMatchObject({ permanent: true, permanentCount: 37, expiry: null });
});

it('starts a new timed folder period on a later upload or restore and preserves permanent replacements', async () => {
  const page = await add('renew/index.html');
  const asset = await add('renew/image.svg');
  const now = Date.now();
  await change('folder:renew', '30-days', now - 10 * DAY_MS);
  await add('renew/new.md', now);
  expect((await listExplorer(env, null)).entries[0]!.expiry).toEqual({ firstAt: now + 30 * DAY_MS, lastAt: now + 30 * DAY_MS });
  await change(page.id, 'permanent', now);
  await uploadFile(env, user, {
    uploadId: await createUpload(env, user), path: page.path, type: '', size: body.length, body, source: 'mcp',
    replace: { id: page.id, version: page.version },
  });
  expect((await listExplorer(env, null, 30, 'files', { folder: 'renew' })).entries.find(entry => entry.id === page.id)).toMatchObject({ permanent: true, expiry: null });
  await trashFile(env, user, asset.id);
  await restoreFile(env, asset.id);
  const restoredAt = await database(sql => sql.exec<{ restored_at: number }>('SELECT restored_at FROM files WHERE id = ?', asset.id).one().restored_at);
  expect((await listExplorer(env, null)).entries[0]!.expiry!.firstAt).toBe(restoredAt + 30 * DAY_MS);
});

it('does not let a pending upload bypass folder permanence or the automatic expiry write guard', async () => {
  await add('pending/index.html');
  const pending = await shelf(env).reserveUpload(user, {
    uploadId: await createUpload(env, user), path: 'pending/new.md', contentType: 'text/markdown', size: body.length, source: 'web',
  });
  const now = Date.now();
  await change('folder:pending', 'permanent', now);
  await env.FILES.put(pending.object_key, body);
  const completed = await shelf(env).completeUpload(pending.id);
  expect((await listExplorer(env, null, 30, 'files', { folder: 'pending' })).entries.find(entry => entry.id === completed.id)).toMatchObject({ permanent: true });
  await change('folder:pending', '30-days', now);
  const replacement = await shelf(env).reserveUpload(user, {
    uploadId: await createUpload(env, user), path: completed.path, contentType: 'text/markdown', size: body.length, source: 'web',
    replace: { id: completed.id, version: completed.version },
  });
  expect(await expire(now + 100 * DAY_MS)).toBe(0);
  await shelf(env).releaseUpload(replacement.id);
  expect(await expire(now + 100 * DAY_MS)).toBe(2);
});

it('keeps manual Trash and restore available, then removes settings when the last file is deleted', async () => {
  const file = await add('disposable/keep.md');
  const now = Date.now();
  await change('folder:disposable', 'permanent', now);
  await change(file.id, 'permanent', now);
  await trashFile(env, user, file.id);
  expect((await listExplorer(env, null, 30, 'trash')).entries[0]).toMatchObject({ permanent: false, permanentCount: 0 });
  await restoreFile(env, file.id);
  expect((await listExplorer(env, null)).entries[0]).toMatchObject({ permanent: true, expiry: null });
  await trashFile(env, user, file.id);
  await deleteFilePermanently(env, file.id, true);
  expect(await database(sql => sql.exec('SELECT id FROM retention_settings').toArray())).toEqual([]);
  await add(file.path);
  expect((await listExplorer(env, null)).entries[0]).toMatchObject({ permanent: false });
});

it('validates the API input, protects the origin, and never treats a path prefix as another folder', async () => {
  const file = await add('percent%_quote\'/note.md');
  const other = await add('percentZZquote\'/other.md');
  const endpoint = 'http://localhost:8787/api/files/retention';
  async function request(payload: unknown, origin?: string) {
    return exports.default.fetch(endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(payload) });
  }
  for (const payload of [null, {}, [], { id: file.id }, { id: file.id, mode: 'forever' },
    { id: 12, mode: 'permanent' }, { id: 'folder:', mode: 'permanent' },
    { id: 'folder:../other', mode: 'permanent' }, { id: file.id, mode: '30-days', now: 0 }]) {
    expect((await request(payload)).status).toBe(400);
  }
  expect((await request({ id: file.id, mode: 'permanent' }, 'https://other.example.test')).status).toBe(403);
  expect((await request({ id: 'folder:missing', mode: 'permanent' })).status).toBe(404);
  const before = Date.now();
  const response = await request({ id: "folder:percent%_quote'", mode: '30-days' });
  expect(response.status).toBe(200);
  const result = await response.json() as { expiresAt: number };
  expect(result.expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
  expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
  expect(await expire(before + 11 * DAY_MS)).toBe(1);
  expect((await getFile(env, other.id)).trashedAt).not.toBeNull();
  expect((await getFile(env, file.id)).trashedAt).toBeNull();
  await trashFile(env, user, file.id);
  expect((await request({ id: file.id, mode: 'permanent' })).status).toBe(404);
});
