import { env, exports } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FilePage, FileSort, FileView } from '../shared/types';
import { listFiles } from '../worker/files';
import { prepareDatabase, resetDatabase, database } from './database';

beforeAll(prepareDatabase);
beforeEach(resetDatabase);

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const records = [
  { name: 'zebra.html', created: 10, trashed: 300 },
  { name: 'Alpha.html', created: 30, trashed: 100 },
  { name: 'alpha.html', created: 30, trashed: 200 },
  { name: 'beta.html', created: 20, trashed: 200 },
  { name: 'café.html', created: 40, trashed: 400 },
  { name: 'Café.html', created: 50, trashed: 400 },
];

async function seed(view: FileView = 'files'): Promise<void> {
  const uploadId = crypto.randomUUID();
  await database(sql => {
    sql.exec('INSERT INTO uploads (id, owner_id, created_at) VALUES (?, ?, ?)', uploadId, 'author', 1);
    records.forEach((record, index) => {
      const trashed = view === 'trash';
      const deleting = trashed && index === 5;
      sql.exec(`INSERT INTO files
        (id, upload_id, path, name, object_key, content_type, size, uploader_id, uploader_email,
          uploader_label, source, status, created_at, trashed_at, delete_started_at)
        VALUES (?, ?, ?, ?, ?, 'text/html', 0, 'author', 'author@example.test', 'author@example.test', 'web', ?, ?, ?, ?)`,
        id(index + 1), uploadId, record.name, record.name, `${uploadId}/${record.name}`,
          deleting ? 'deleting' : trashed ? 'trashed' : 'ready', record.created, trashed ? record.trashed : null, deleting ? 500 : null);
    });
  });
}

describe.each(['files', 'trash'] as const)('%s sorting', view => {
  const orders: Record<FileSort, number[]> = view === 'files'
    ? { newest: [6, 5, 3, 2, 4, 1], oldest: [1, 4, 2, 3, 5, 6], name: [2, 3, 4, 5, 6, 1] }
    : { newest: [6, 5, 1, 4, 3, 2], oldest: [2, 3, 4, 1, 5, 6], name: [2, 3, 4, 5, 6, 1] };

  it.each(['newest', 'oldest', 'name'] as const)('keeps %s order across pages with equal names and dates', async sort => {
    await seed(view);
    const found: string[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < records.length; index++) {
      const page: FilePage = await listFiles(env, cursor, 1, view, { sort });
      expect(page.total).toBe(records.length);
      expect(page.files).toHaveLength(1);
      found.push(page.files[0]!.id);
      cursor = page.nextCursor;
      if (index < records.length - 1) expect(cursor).not.toBeNull();
    }
    expect(cursor).toBeNull();
    expect(found).toEqual(orders[sort].map(id));
  });
});

it('combines sorting and filters, and rejects cursors from another order, search, or view', async () => {
  await seed();
  const query = { sort: 'oldest' as const, q: 'café', author: 'author', type: 'text/html' };
  const first = await listFiles(env, null, 1, 'files', query);
  expect(first.files[0]!.id).toBe(id(5));
  expect(first.total).toBe(2);
  const second = await listFiles(env, first.nextCursor, 1, 'files', query);
  expect(second.files.map(file => file.id)).toEqual([id(6)]);
  expect(second.nextCursor).toBeNull();
  for (const sort of ['newest', 'name'] as const) {
    await expect(listFiles(env, first.nextCursor, 1, 'files', { ...query, sort })).rejects.toMatchObject({ status: 400 });
  }
  await expect(listFiles(env, first.nextCursor, 1, 'files', { ...query, q: 'alpha' })).rejects.toMatchObject({ status: 400 });
  await expect(listFiles(env, first.nextCursor, 1, 'trash', query)).rejects.toMatchObject({ status: 400 });
});

it('keeps newest as the default and accepts previous newest-first cursors', async () => {
  await seed();
  const first = await listFiles(env, null, 1);
  expect(first.files[0]!.id).toBe(id(6));
  for (const parts of [[50, id(6)], ['files', 50, id(6)], ['files', JSON.stringify(['', '', '']), 50, id(6)]]) {
    const cursor = btoa(JSON.stringify(parts));
    expect((await listFiles(env, cursor, 1)).files[0]!.id).toBe(id(5));
    await expect(listFiles(env, cursor, 1, 'files', { sort: 'oldest' })).rejects.toMatchObject({ status: 400 });
  }
});

it('passes sorting through HTTP and rejects unsupported sort values', async () => {
  await seed();
  const response = await exports.default.fetch('http://localhost:8787/api/files?sort=oldest&limit=1');
  expect(response.status).toBe(200);
  const first = await response.json() as FilePage;
  expect(first.files[0]!.id).toBe(id(1));
  const next = await exports.default.fetch(`http://localhost:8787/api/files?sort=oldest&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
  expect((await next.json() as FilePage).files[0]!.id).toBe(id(4));
  for (const sort of ['', 'ascending', 'name DESC']) {
    const invalid = await exports.default.fetch(`http://localhost:8787/api/files?sort=${encodeURIComponent(sort)}`);
    expect(invalid.status).toBe(400);
  }
});
