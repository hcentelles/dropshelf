import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import originalSchema from '../migrations/0001_files.sql?raw';
import trashSchema from '../migrations/0002_trash.sql?raw';
import sortingSchema from '../migrations/0003_file_name_order.sql?raw';

it('preserves existing file records, upload groups, and content while adding Trash and sort indexes', async () => {
  const apply = (sql: string) => env.DB.batch(sql.split(';').map(item => item.trim()).filter(Boolean).map(item => env.DB.prepare(item)));
  await apply(originalSchema);
  const group = crypto.randomUUID();
  const file = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO uploads (id, owner_id, created_at) VALUES (?, ?, ?)').bind(group, 'existing-owner', 123).run();
  for (const [id, path, status] of [[file, 'folder/café.html', 'ready'], [crypto.randomUUID(), 'pending.csv', 'uploading']]) {
    await env.DB.prepare(`INSERT INTO files
      (id, upload_id, path, name, object_key, content_type, size, uploader_id, uploader_email, uploader_label, source, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, group, path, path!.split('/').at(-1), `${group}/${path}`, 'text/html', 17,
        'existing-owner', 'existing@example.test', 'existing@example.test', 'web', status, 123).run();
  }
  await env.FILES.put(`${group}/folder/café.html`, '<h1>Existing</h1>');
  const before = await env.DB.prepare('SELECT * FROM files ORDER BY id').all();
  await apply(trashSchema);
  await apply(sortingSchema);
  const after = await env.DB.prepare(`SELECT id, upload_id, path, name, object_key, content_type, size,
    uploader_id, uploader_email, uploader_label, source, status, created_at FROM files ORDER BY id`).all();
  expect(after.results).toEqual(before.results);
  expect(await env.DB.prepare('SELECT owner_id FROM uploads WHERE id = ?').bind(group).first('owner_id')).toBe('existing-owner');
  const content = await exports.default.fetch(`http://127.0.0.1:8787/f/${group}/folder/caf%C3%A9.html`);
  expect(content.status).toBe(200);
  expect(await content.text()).toBe('<h1>Existing</h1>');
});
