import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { DAY_MS, parseRetentionDays, retentionPolicy } from '../shared/retention';
import { createUpload, getFile, listExplorer, uploadFile } from '../worker/files';
import { beginExpiredDeletion, moveExpiredToTrash, RETENTION_DELETE_BATCH } from '../worker/retention-store';
import { runRetention } from '../worker/retention';
import { shelf } from '../worker/shelf-client';
import { restoreFile, trashFile } from '../worker/trash';
import { database, resetDatabase } from './database';
import worker from '../worker/index';
import { queryExplorer } from '../worker/explorer';

beforeEach(resetDatabase);
const user = { id: 'writer', email: 'writer@example.test', label: 'Writer', kind: 'user' as const };
const body = new TextEncoder().encode('Retention test');

async function add(path: string, updatedAt = Date.now(), createdAt = updatedAt) {
  const file = await uploadFile(env, user, {
    uploadId: await createUpload(env, user), path, type: '', size: body.length, body, source: 'web',
  });
  const key = await database(sql => {
    sql.exec('UPDATE files SET created_at = ?, updated_at = ? WHERE id = ?', createdAt, updatedAt, file.id);
    return sql.exec<{ object_key: string }>('SELECT object_key FROM files WHERE id = ?', file.id).one().object_key;
  });
  return { ...await getFile(env, file.id), key };
}

const expireAt = (now: number, days = 30) => runInDurableObject(shelf(env), (_instance, state) => moveExpiredToTrash(state.storage, days, now));
const claimAt = (now: number, days = 7) => runInDurableObject(shelf(env), (_instance, state) => beginExpiredDeletion(state.storage, days, now));

it('uses the last upload or replacement date, with an exact day boundary and no reset on reads', async () => {
  const now = Date.now();
  const due = await add('due.html', now - 30 * DAY_MS);
  const early = await add('early.html', now - 30 * DAY_MS + 1);
  const replaced = await add('replaced.html', now - DAY_MS, now - 90 * DAY_MS);
  expect((await exports.default.fetch(due.url)).status).toBe(200);
  expect((await exports.default.fetch(due.url, { method: 'HEAD' })).status).toBe(200);
  expect(await expireAt(now)).toBe(1);
  expect(await getFile(env, due.id)).toMatchObject({ trashedAt: now, trashedBy: 'Automatic expiry', deletionPending: false });
  for (const file of [early, replaced]) expect((await getFile(env, file.id)).trashedAt).toBeNull();
  expect((await exports.default.fetch(due.url)).status).toBe(404);
  expect(await env.FILES.head(due.key)).not.toBeNull();
  expect(await expireAt(now)).toBe(0);
});

it('expires each top-level folder as a whole across upload groups and nested folders', async () => {
  const now = Date.now();
  const old = now - 31 * DAY_MS;
  const active = [await add('site/index.html', now), await add('site/assets/style.css', old)];
  const expired = [await add('site-old/index.html', old), await add('site-old/assets/app.js', old)];
  expect(await expireAt(now)).toBe(2);
  for (const file of active) expect((await getFile(env, file.id)).trashedAt).toBeNull();
  for (const file of expired) expect((await getFile(env, file.id)).trashedAt).toBe(now);
  expect((await listExplorer(env, null)).entries.map(entry => entry.path)).toEqual(['site']);
  expect((await listExplorer(env, null, 30, 'trash')).entries[0]).toMatchObject({ path: 'site-old', fileCount: 2 });
});

it('resets the folder period only after a replacement completes', async () => {
  const old = Date.now() - 90 * DAY_MS;
  const page = await add('site/index.html', old);
  const asset = await add('site/style.css', old);
  const updated = await uploadFile(env, user, {
    uploadId: await createUpload(env, user), path: page.path, type: '', size: body.length, body, source: 'mcp',
    replace: { id: page.id, version: page.version },
  });
  expect(updated).toMatchObject({ id: page.id, url: page.url, version: 2, createdAt: old });
  expect(await expireAt(Date.now())).toBe(0);
  expect((await getFile(env, asset.id)).trashedAt).toBeNull();
});

it('does not expire a folder while a new file or a replacement is still being written', async () => {
  const now = Date.now();
  const page = await add('site/index.html', now - 31 * DAY_MS);
  const root = await add('root.html', now - 31 * DAY_MS);
  const pending = await shelf(env).reserveUpload(user, {
    uploadId: await createUpload(env, user), path: 'site/new.css', contentType: 'text/css', size: 1, source: 'web',
  });
  const replacing = await shelf(env).reserveUpload(user, {
    uploadId: await createUpload(env, user), path: root.path, contentType: 'text/html', size: 1, source: 'web',
    replace: { id: root.id, version: root.version },
  });
  expect(await expireAt(now)).toBe(0);
  expect((await getFile(env, page.id)).trashedAt).toBeNull();
  await shelf(env).releaseUpload(pending.id);
  await shelf(env).releaseUpload(replacing.id);
  expect(await expireAt(now)).toBe(2);
});

it('gives a restored file a full new period without changing its URL or upload dates', async () => {
  const file = await add('restored.html', Date.now() - 90 * DAY_MS);
  await expireAt(Date.now());
  const restored = await restoreFile(env, file.id);
  expect(restored).toMatchObject({ url: file.url, createdAt: file.createdAt, updatedAt: file.updatedAt, version: file.version });
  const restoredAt = await database(sql => sql.exec<{ restored_at: number }>('SELECT restored_at FROM files WHERE id = ?', file.id).one().restored_at);
  await restoreFile(env, file.id);
  await evictDurableObject(shelf(env));
  expect(await expireAt(restoredAt + 30 * DAY_MS - 1)).toBe(0);
  expect((await exports.default.fetch(file.url)).status).toBe(200);
  expect(await expireAt(restoredAt + 30 * DAY_MS)).toBe(1);
});

it('starts the Trash period when expiry runs, then removes bytes and metadata with safe retries', async () => {
  const file = await add('expired.html', Date.now() - 365 * DAY_MS);
  expect(await runRetention(env)).toEqual({ trashed: 1, deleted: 0, failed: 0 });
  const trashed = await getFile(env, file.id);
  expect(trashed.trashedAt).toBeGreaterThan(file.updatedAt);
  expect(await env.FILES.head(file.key)).not.toBeNull();
  expect(await runRetention(env)).toEqual({ trashed: 0, deleted: 0, failed: 0 });
  await database(sql => { sql.exec('UPDATE files SET trashed_at = ? WHERE id = ?', Date.now() - 7 * DAY_MS - 1, file.id); });
  expect(await runRetention(env)).toEqual({ trashed: 0, deleted: 1, failed: 0 });
  expect(await env.FILES.head(file.key)).toBeNull();
  await expect(getFile(env, file.id)).rejects.toMatchObject({ status: 404 });
  expect((await exports.default.fetch(file.url)).status).toBe(404);
  expect(await runRetention(env)).toEqual({ trashed: 0, deleted: 0, failed: 0 });
  expect(await database(sql => sql.exec('SELECT id FROM deleted_files WHERE id = ?', file.id).toArray())).toHaveLength(1);
});

it('uses the Trash date for manual moves and checks the boundary before blocking restore', async () => {
  const now = Date.now();
  const due = await add('manual.html');
  const early = await add('early.html');
  for (const file of [due, early]) await trashFile(env, user, file.id);
  await database(sql => {
    sql.exec('UPDATE files SET trashed_at = ? WHERE id = ?', now - 7 * DAY_MS, due.id);
    sql.exec('UPDATE files SET trashed_at = ? WHERE id = ?', now - 7 * DAY_MS + 1, early.id);
  });
  expect(await claimAt(now)).toEqual([{ id: due.id, object_key: due.key }]);
  await expect(restoreFile(env, due.id)).rejects.toMatchObject({ status: 409 });
  expect((await restoreFile(env, early.id)).trashedAt).toBeNull();
  await trashFile(env, user, early.id);
  expect(await runRetention(env)).toEqual({ trashed: 0, deleted: 1, failed: 0 });
  expect((await getFile(env, early.id)).deletionPending).toBe(false);
  expect(await env.FILES.head(early.key)).not.toBeNull();
});

it('keeps failed R2 deletion pending across restarts and retries it on the next run', async () => {
  const file = await add('retry.html');
  await trashFile(env, user, file.id);
  await database(sql => { sql.exec('UPDATE files SET trashed_at = 0 WHERE id = ?', file.id); });
  const failingEnv = { ...env, FILES: new Proxy(env.FILES, {
    get(target, key) { return key === 'delete' ? async () => { throw new Error('R2 test failure'); } : Reflect.get(target, key); },
  }) };
  expect(await runRetention(failingEnv)).toEqual({ trashed: 0, deleted: 0, failed: 1 });
  await evictDurableObject(shelf(env));
  expect((await getFile(env, file.id)).deletionPending).toBe(true);
  expect(await env.FILES.head(file.key)).not.toBeNull();
  await expect(restoreFile(env, file.id)).rejects.toMatchObject({ status: 409 });
  expect(await runRetention(env)).toEqual({ trashed: 0, deleted: 1, failed: 0 });
  expect(await env.FILES.head(file.key)).toBeNull();
});

it('retries a metadata failure after bytes are gone without allowing a broken restore', async () => {
  const file = await add('metadata.html');
  await trashFile(env, user, file.id);
  await database(sql => {
    sql.exec('UPDATE files SET trashed_at = 0 WHERE id = ?', file.id);
    sql.exec("CREATE TRIGGER fail_retention_delete BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT, 'Metadata test failure'); END;");
  });
  try {
    expect(await runRetention(env)).toEqual({ trashed: 0, deleted: 0, failed: 1 });
    expect(await env.FILES.head(file.key)).toBeNull();
    await expect(restoreFile(env, file.id)).rejects.toMatchObject({ status: 409 });
  } finally { await database(sql => { sql.exec('DROP TRIGGER fail_retention_delete'); }); }
  expect(await runRetention(env)).toEqual({ trashed: 0, deleted: 1, failed: 0 });
});

it('supports independent disabled steps and validates both settings before changing files', async () => {
  expect(retentionPolicy({})).toEqual({ fileDays: 0, trashDays: 0 });
  expect(retentionPolicy({ FILE_RETENTION_DAYS: '90', TRASH_RETENTION_DAYS: '30' })).toEqual({ fileDays: 90, trashDays: 30 });
  for (const value of ['-1', '', '1.5', 'bad', 'Infinity', ' 7 ', null, false, 36501]) {
    expect(() => parseRetentionDays(value, 'days')).toThrow('whole number');
  }
  const file = await add('disabled.html', Date.now() - 90 * DAY_MS);
  await expect(runRetention({ ...env, TRASH_RETENTION_DAYS: '-1' })).rejects.toThrow('TRASH_RETENTION_DAYS');
  expect((await getFile(env, file.id)).trashedAt).toBeNull();
  expect(await expireAt(Date.now(), 0)).toBe(0);
  expect(await expireAt(Date.now(), 30)).toBe(1);
  expect(await claimAt(Date.now() + 100 * DAY_MS, 0)).toEqual([]);
  const pending = await claimAt(Date.now() + 100 * DAY_MS, 7);
  expect(pending).toHaveLength(1);
  expect(await claimAt(Date.now() + 100 * DAY_MS, 0)).toEqual(pending);
});

it('bounds each deletion run and leaves the rest available for the next run', async () => {
  const template = await add('template.html');
  await trashFile(env, user, template.id);
  await database(sql => {
    sql.exec('UPDATE files SET trashed_at = 0 WHERE id = ?', template.id);
    for (let index = 0; index < RETENTION_DELETE_BATCH; index++) {
      const id = crypto.randomUUID();
      sql.exec(`INSERT INTO files
        (id, upload_id, path, name, object_key, content_type, size, uploader_id, uploader_label, source, status, created_at, updated_at, trashed_at)
        VALUES (?, ?, ?, ?, ?, 'text/html', 1, 'writer', 'Writer', 'web', 'trashed', 0, 0, 0)`,
      id, template.uploadId, `${id}.html`, `${id}.html`, `objects/${id}`);
    }
  });
  expect(await runRetention(env)).toEqual({ trashed: 0, deleted: RETENTION_DELETE_BATCH, failed: 0 });
  expect(await runRetention(env)).toEqual({ trashed: 0, deleted: 1, failed: 0 });
});

it('reports the configured periods through the authenticated app API', async () => {
  const response = await exports.default.fetch('http://localhost:8787/api/config');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ retention: { fileDays: 30, trashDays: 7 } });
});

it('runs through the scheduled handler and notifies open pages of automatic changes', async () => {
  const file = await add('scheduled.html', Date.now() - 31 * DAY_MS);
  const response = await exports.default.fetch('http://localhost:8787/api/updates', {
    headers: { Upgrade: 'websocket', Origin: 'http://localhost:8787' },
  });
  const socket = response.webSocket!;
  const messages: unknown[] = [];
  socket.addEventListener('message', event => { messages.push(event.data); });
  socket.accept();
  try {
    await expect.poll(() => messages.length).toBe(1);
    const controller: ScheduledController = { scheduledTime: Date.now(), cron: '0 * * * *', noRetry() {} };
    await worker.scheduled(controller, env);
    await expect.poll(() => messages.length).toBe(2);
    expect((await getFile(env, file.id)).trashedBy).toBe('Automatic expiry');
    await database(sql => { sql.exec('UPDATE files SET trashed_at = 0 WHERE id = ?', file.id); });
    await worker.scheduled(controller, env);
    await expect.poll(() => messages.length).toBe(4);
    expect(await env.FILES.head(file.key)).toBeNull();
  } finally { socket.close(); }
});

it('keeps restore and scheduled deletion consistent when they run at the same time', async () => {
  for (let index = 0; index < 4; index++) {
    const file = await add(`race-${index}.html`);
    await trashFile(env, user, file.id);
    await database(sql => { sql.exec('UPDATE files SET trashed_at = 0 WHERE id = ?', file.id); });
    const restore = () => restoreFile(env, file.id);
    const results = await Promise.allSettled(index % 2 ? [runRetention(env), restore()] : [restore(), runRetention(env)]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    const row = await database(sql => sql.exec<{ status: string }>('SELECT status FROM files WHERE id = ?', file.id).toArray()[0]);
    if (row) {
      expect(row.status).toBe('ready');
      expect(await env.FILES.head(file.key)).not.toBeNull();
      expect((await exports.default.fetch(file.url)).status).toBe(200);
    } else {
      expect(await env.FILES.head(file.key)).toBeNull();
      expect((await exports.default.fetch(file.url)).status).toBe(404);
    }
  }
});

it('reports one active expiry date for a whole root folder, across filters, nested views, and pages', async () => {
  const now = Date.now();
  const old = await add('site/nested/old.html', now - 20 * DAY_MS);
  await add('site/nested/second.html', now - 19 * DAY_MS);
  await add('site/new.css', now);
  await add('site-other/independent.html', now - 10 * DAY_MS);
  const expected = { firstAt: now + 30 * DAY_MS, lastAt: now + 30 * DAY_MS };
  const root = await listExplorer(env, null, 30, 'files', { q: 'old.html' });
  expect(root.entries[0]).toMatchObject({ path: 'site', expiry: expected });
  const first = await listExplorer(env, null, 1, 'files', { folder: 'site/nested', sort: 'name' });
  expect(first.entries[0]).toMatchObject({ id: old.id, expiry: expected });
  const second = await listExplorer(env, first.nextCursor, 1, 'files', { folder: 'site/nested', sort: 'name' });
  expect(second.entries[0]!.expiry).toEqual(expected);
  expect((await listExplorer(env, null, 30, 'files', { folder: 'site-other' })).entries[0]!.expiry?.firstAt).toBe(now + 20 * DAY_MS);
});

it('uses the restore date in displayed expiry and still keeps the original upload date', async () => {
  const file = await add('restored-display.html', Date.now() - 90 * DAY_MS);
  await trashFile(env, user, file.id);
  await restoreFile(env, file.id);
  const restoredAt = await database(sql => sql.exec<{ restored_at: number }>('SELECT restored_at FROM files WHERE id = ?', file.id).one().restored_at);
  const row = (await listExplorer(env, null)).entries[0]!;
  expect(row).toMatchObject({ updatedAt: file.updatedAt, expiry: { firstAt: restoredAt + 30 * DAY_MS, lastAt: restoredAt + 30 * DAY_MS } });
  expect(await expireAt(row.expiry!.firstAt - 1)).toBe(0);
  expect(await expireAt(row.expiry!.firstAt)).toBe(1);
});

it('reports the full range of Trash dates for folders and each file date inside them', async () => {
  const now = Date.now();
  const early = await add('trash-range/early.html');
  const late = await add('trash-range/nested/late.html');
  for (const file of [early, late]) await trashFile(env, user, file.id);
  await database(sql => {
    sql.exec('UPDATE files SET trashed_at = ? WHERE id = ?', now - 5 * DAY_MS, early.id);
    sql.exec('UPDATE files SET trashed_at = ? WHERE id = ?', now, late.id);
  });
  const folder = (await listExplorer(env, null, 30, 'trash', { q: 'early' })).entries[0]!;
  expect(folder.expiry).toEqual({ firstAt: now + 2 * DAY_MS, lastAt: now + 7 * DAY_MS });
  const nested = (await listExplorer(env, null, 30, 'trash', { folder: 'trash-range' })).entries;
  expect(nested.find(row => row.id === early.id)!.expiry).toEqual({ firstAt: now + 2 * DAY_MS, lastAt: now + 2 * DAY_MS });
  expect(nested.find(row => row.path === 'trash-range/nested')!.expiry).toEqual({ firstAt: now + 7 * DAY_MS, lastAt: now + 7 * DAY_MS });
});

it('reports no automatic deadline for a disabled step', async () => {
  const file = await add('disabled-display.html');
  const off = { ...env, FILE_RETENTION_DAYS: '0', TRASH_RETENTION_DAYS: '0' };
  expect((await database(sql => queryExplorer(sql, off, null))).entries[0]!.expiry).toBeNull();
  await trashFile(env, user, file.id);
  expect((await database(sql => queryExplorer(sql, off, null, 30, 'trash'))).entries[0]!.expiry).toBeNull();
});
