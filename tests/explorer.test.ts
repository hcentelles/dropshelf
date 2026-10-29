import { env, exports } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isFolder, type ExplorerPage, type FileSort, type FileView } from '../shared/types';
import { getFileFilters, listExplorer, listFiles } from '../worker/files';
import { prepareDatabase, resetDatabase, database } from './database';

beforeAll(prepareDatabase);
beforeEach(resetDatabase);

async function seed(paths: string[], view: FileView = 'files'): Promise<string> {
  const uploadId = crypto.randomUUID();
  await database(sql => {
    sql.exec('INSERT INTO uploads (id, owner_id, created_at) VALUES (?, ?, 1)', uploadId, 'author');
    paths.forEach((path, index) => sql.exec(`INSERT INTO files
      (id, upload_id, path, name, object_key, content_type, size, uploader_id, uploader_label, source, status, created_at, trashed_at)
      VALUES (?, ?, ?, ?, ?, ?, 10, 'author', 'Author', 'web', ?, ?, ?)`,
      crypto.randomUUID(), uploadId, path, path.split('/').at(-1)!, `${uploadId}/${path}`,
        path.endsWith('.css') ? 'text/css' : 'text/html', view === 'trash' ? 'trashed' : 'ready', index + 1,
        view === 'trash' ? index + 100 : null));
  });
  return uploadId;
}

describe.each(['files', 'trash'] as const)('%s explorer', view => {
  it('shows only immediate children at each level and keeps separate uploads apart', async () => {
    const uploadId = await seed(['site/index.html', 'site/assets/styles.css', 'site/assets/deep/page.html', 'standalone.html'], view);
    const other = await seed(['site/other.html'], view);
    const root = await listExplorer(env, null, 30, view);
    expect(root.total).toBe(3);
    expect(root.entries.filter(isFolder).map(folder => folder.uploadId).sort()).toEqual([uploadId, other].sort());
    expect(root.entries.find(entry => entry.uploadId === uploadId && isFolder(entry))).toMatchObject({ path: 'site', fileCount: 3, size: 30 });
    expect(root.entries.at(-1)!.name).toBe('standalone.html');
    const site = await listExplorer(env, null, 30, view, { uploadId, folder: 'site' });
    expect(site.entries.map(entry => entry.name)).toEqual(['assets', 'index.html']);
    expect(site.entries[0]).toMatchObject({ path: 'site/assets', fileCount: 2 });
    const assets = await listExplorer(env, null, 30, view, { uploadId, folder: 'site/assets' });
    expect(assets.entries.map(entry => entry.name)).toEqual(['deep', 'styles.css']);
    const deep = await listExplorer(env, null, 30, view, { uploadId, folder: 'site/assets/deep' });
    expect(deep.entries.map(entry => entry.name)).toEqual(['page.html']);
    expect((await listFiles(env, null, 30, view, { uploadId, folder: 'site' })).total).toBe(3);
  });

  it.each(['newest', 'oldest', 'name'] as const)('groups before pagination and keeps folders first with %s sorting', async sort => {
    await seed([...Array.from({ length: 75 }, (_, index) => `bulk/child-${index}.html`), 'Zulu/z.html', 'alpha/a.html', 'z.html', 'A.html'], view);
    const pages: string[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 5; index++) {
      const page: ExplorerPage = await listExplorer(env, cursor, 1, view, { sort });
      expect(page.total).toBe(5);
      expect(page.entries).toHaveLength(1);
      const entry = page.entries[0]!;
      expect(isFolder(entry)).toBe(index < 3);
      if (entry.name === 'bulk') expect(entry).toMatchObject({ fileCount: 75, size: 750 });
      pages.push(entry.name);
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    const order: Record<FileSort, string[]> = {
      newest: ['alpha', 'Zulu', 'bulk', 'A.html', 'z.html'],
      oldest: ['bulk', 'Zulu', 'alpha', 'z.html', 'A.html'],
      name: ['alpha', 'bulk', 'Zulu', 'A.html', 'z.html'],
    };
    expect(pages).toEqual(order[sort]);
  });
});

it('filters descendants but keeps full folder totals and treats path wildcard characters literally', async () => {
  const uploadId = await seed(['100%_café/assets/a.css', '100%_café/page.html', '100XXcafé/other.html']);
  const root = await listExplorer(env, null, 30, 'files', { q: 'a.css', type: 'text/css', author: 'author' });
  expect(root.total).toBe(1);
  expect(root.entries[0]).toMatchObject({ name: '100%_café', fileCount: 2, size: 20 });
  const scope = { uploadId, folder: '100%_café' };
  expect((await listExplorer(env, null, 30, 'files', scope)).total).toBe(2);
  expect((await listFiles(env, null, 30, 'files', scope)).total).toBe(2);
  expect((await getFileFilters(env, 'files', scope)).types).toHaveLength(2);
  const literal = await listExplorer(env, null, 30, 'files', { q: '%_' });
  expect(literal.entries.map(entry => entry.name)).toEqual(['100%_café']);
  expect((await listExplorer(env, null, 30, 'files', { ...scope, q: '100%_café' })).total).toBe(0);
});

it('binds cursors to their folder, filters, sort, and view and validates the HTTP scope', async () => {
  const uploadId = await seed(['site/a.html', 'site/b.html', 'other.html']);
  const scope = { uploadId, folder: 'site' };
  const first = await listExplorer(env, null, 1, 'files', scope);
  for (const query of [{}, { ...scope, folder: 'other' }, { ...scope, sort: 'name' as const }, { ...scope, q: 'a' }]) {
    await expect(listExplorer(env, first.nextCursor, 1, 'files', query)).rejects.toMatchObject({ status: 400 });
  }
  await expect(listExplorer(env, first.nextCursor, 1, 'trash', scope)).rejects.toMatchObject({ status: 400 });
  const flat = await listFiles(env, null, 1, 'files', scope);
  await expect(listFiles(env, flat.nextCursor, 1)).rejects.toMatchObject({ status: 400 });
  for (const query of ['folder=site', `uploadId=${uploadId}`, `uploadId=${uploadId}&folder=../site`, 'view=invalid', 'cursor=invalid', 'limit=101']) {
    const response = await exports.default.fetch(`http://localhost:8787/api/explorer?${query}`);
    expect(response.status).toBe(400);
  }
  const response = await exports.default.fetch(`http://localhost:8787/api/explorer?uploadId=${uploadId}&folder=site`);
  expect(response.status).toBe(200);
  expect((await response.json() as ExplorerPage).total).toBe(2);
});

it('removes empty folders after Trash changes and recreates them on restore', async () => {
  const uploadId = await seed(['site/deep/index.html']);
  const file = (await listFiles(env, null, 30, 'files', { uploadId, folder: 'site' })).files[0]!;
  const post = (action: string) => exports.default.fetch(`http://localhost:8787/api/files/${file.id}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  expect((await post('trash')).status).toBe(200);
  expect((await listExplorer(env, null)).entries).toEqual([]);
  expect((await listExplorer(env, null, 30, 'trash')).entries[0]).toMatchObject({ name: 'site', fileCount: 1 });
  expect((await post('restore')).status).toBe(200);
  expect((await listExplorer(env, null)).entries[0]).toMatchObject({ name: 'site', fileCount: 1 });
  expect((await listExplorer(env, null, 30, 'trash')).entries).toEqual([]);
});
