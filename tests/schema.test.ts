import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { initializeSchema } from '../worker/schema';
import legacySchema from './fixtures/metadata-v1.sql?raw';

it('upgrades existing metadata, preserves duplicate contents and every old URL, and is repeatable', async () => {
  const stub = env.SHELF.getByName(`migration-${crypto.randomUUID()}`);
  const records = [
    { id: crypto.randomUUID(), uploadId: crypto.randomUUID(), path: 'site/index.html' },
    { id: crypto.randomUUID(), uploadId: crypto.randomUUID(), path: 'site/index.html' },
    { id: crypto.randomUUID(), uploadId: crypto.randomUUID(), path: 'file.html' },
    { id: crypto.randomUUID(), uploadId: crypto.randomUUID(), path: 'file.html/child.html' },
  ];
  const trashedId = crypto.randomUUID();
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
    const sql = state.storage.sql;
    sql.exec(legacySchema);
    records.forEach((record, index) => {
      sql.exec('INSERT INTO uploads VALUES (?, ?, ?)', record.uploadId, 'writer', index);
      sql.exec(`INSERT INTO files
        (id, upload_id, path, name, object_key, content_type, size, uploader_id, uploader_label, source, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'text/html', 3, 'writer', 'Writer', 'web', 'ready', ?)`,
      record.id, record.uploadId, record.path, record.path.split('/').at(-1)!, `${record.uploadId}/${record.path}`, index);
    });
    // This old Trash record must not collide with a duplicate's new name.
    sql.exec(`INSERT INTO files
      (id, upload_id, path, name, object_key, content_type, size, uploader_id, uploader_label, source, status, created_at, trashed_at)
      VALUES (?, ?, 'site/index (copy 2).html', 'index (copy 2).html', ?, 'text/html', 3, 'writer', 'Writer', 'web', 'trashed', 1, 2)`,
    trashedId, records[1]!.uploadId, `${records[1]!.uploadId}/site/index (copy 2).html`);
    initializeSchema(state.storage);
    initializeSchema(state.storage);
    expect(sql.exec('SELECT version FROM schema_migrations ORDER BY version').toArray()).toEqual(
      [1, 2, 3, 4, 5, 6].map(version => ({ version })),
    );
    expect(sql.exec('SELECT id FROM retention_settings').toArray()).toEqual([]);
    expect(sql.exec('SELECT restored_at FROM files WHERE restored_at IS NOT NULL').toArray()).toEqual([]);
    expect(sql.exec('SELECT id FROM files').toArray()).toHaveLength(5);
    expect(sql.exec('SELECT path FROM files GROUP BY path').toArray()).toHaveLength(5);
  });
  await evictDurableObject(stub);
  for (const record of records) {
    const file = await stub.getFile(record.id);
    expect(file.url).toBe(`${env.CONTENT_ORIGIN}/f/${record.uploadId}/${record.path}`);
    expect((await stub.findContent(record.uploadId, record.path)).object_key).toBe(`${record.uploadId}/${record.path}`);
  }
  expect((await stub.getFile(records[1]!.id)).path).toBe('site/index (copy 3).html');
  expect((await stub.getFile(trashedId)).trashedAt).toBe(2);
  expect((await stub.getFile(records[2]!.id)).path).toBe('file (copy 2).html');
});

it('preserves active single-file transfer grants when batch grants are enabled', async () => {
  const stub = env.SHELF.getByName(`transfer-migration-${crypto.randomUUID()}`);
  const id = crypto.randomUUID();
  const grant = { method: 'GET', userId: 'reader', fileId: crypto.randomUUID(), version: 1 } as const;
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`
      DELETE FROM schema_migrations WHERE version = 6;
      DROP TABLE transfer_grants;
      CREATE TABLE transfer_grants (
        id TEXT PRIMARY KEY, method TEXT NOT NULL CHECK (method IN ('GET', 'PUT')),
        grant_json TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX transfer_grants_expiry ON transfer_grants(expires_at);
    `);
    sql.exec('INSERT INTO transfer_grants VALUES (?, ?, ?, ?)', id, grant.method, JSON.stringify(grant), Date.now() + 60_000);
    initializeSchema(state.storage);
  });
  expect(await stub.consumeTransfer(id, 'GET')).toEqual(grant);
  expect(await stub.consumeTransfer(id, 'GET')).toBeNull();
});
