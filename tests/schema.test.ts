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
    expect(sql.exec('SELECT version FROM schema_migrations ORDER BY version').toArray()).toEqual([{ version: 1 }, { version: 2 }]);
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
