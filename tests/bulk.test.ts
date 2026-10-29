import { env, exports } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prepareDatabase } from './database';
import { createUpload, getFile, listFiles, uploadFile } from '../worker/files';
import { getFileFilters } from '../worker/file-query';
import { manageFiles } from '../worker/bulk';
import { trashFile } from '../worker/trash';

beforeAll(prepareDatabase);
beforeEach(async () => {
  await env.DB.batch(['DELETE FROM files', 'DELETE FROM uploads', 'DELETE FROM deleted_files'].map(sql => env.DB.prepare(sql)));
});

const alice = { id: 'author-alice', label: 'alice@example.test', email: 'alice@example.test', kind: 'user' as const };
const bob = { id: 'author-bob', label: 'bob@example.test', email: 'bob@example.test', kind: 'user' as const };
async function add(path: string, owner = alice) {
  const uploadId = await createUpload(env, owner);
  const body = new TextEncoder().encode(path.endsWith('.pdf') ? '%PDF-1.4\nTest PDF bytes' : '<h1>Test</h1>');
  return uploadFile(env, owner, { uploadId, path, type: '', size: body.length, body, source: 'web' });
}

describe('search, filters, and bulk actions', () => {
  it('combines name search, type, and author across all history pages', async () => {
    for (let index = 0; index < 32; index++) await add(`report-${index}.html`);
    const pdf = await add('Annual Report.pdf', bob);
    await add('unrelated.pdf', bob);
    const matching = await listFiles(env, null, 30, 'files', { q: 'REPORT', type: 'application/pdf', author: bob.id });
    expect(matching.total).toBe(1);
    expect(matching.files[0]!.id).toBe(pdf.id);
    expect((await listFiles(env, null, 30, 'files', { q: 'report' })).total).toBe(33);
    const filters = await getFileFilters(env);
    expect(filters.total).toBe(34);
    expect(filters.authors.find(item => item.value === alice.id)?.count).toBe(32);
    expect(filters.types.find(item => item.value === 'application/pdf')?.label).toBe('PDF');
  });

  it('treats search wildcards literally and keeps Unicode cursors tied to their filters', async () => {
    const literal = await add('Café_100%.html');
    await add('CaféA100x.html');
    await add('CaféB100x.html');
    expect((await listFiles(env, null, 30, 'files', { q: '_100%' })).files.map(file => file.id)).toEqual([literal.id]);
    expect((await listFiles(env, null, 30, 'files', { q: "' OR 1=1 --" })).total).toBe(0);
    const first = await listFiles(env, null, 1, 'files', { q: 'Café' });
    expect(first.nextCursor).not.toBeNull();
    const second = await listFiles(env, first.nextCursor, 1, 'files', { q: 'Café' });
    expect(second.files[0]!.id).not.toBe(first.files[0]!.id);
    await expect(listFiles(env, first.nextCursor, 1, 'files', { q: 'Other' })).rejects.toMatchObject({ status: 400 });
  });

  it('groups image formats and filters authors in the correct view', async () => {
    await add('one.png');
    const second = await add('two.jpg', bob);
    const html = await add('page.html', bob);
    expect((await listFiles(env, null, 30, 'files', { type: 'image/*' })).total).toBe(2);
    expect((await getFileFilters(env)).types.find(item => item.value === 'image/*')?.count).toBe(2);
    await trashFile(env, alice, second.id);
    expect((await getFileFilters(env, 'trash')).authors[0]!.value).toBe(bob.id);
    expect((await listFiles(env, null, 30, 'trash', { author: bob.id })).files[0]!.id).toBe(second.id);
    expect((await listFiles(env, null, 30, 'files', { author: bob.id })).files[0]!.id).toBe(html.id);
  });

  it('reports each bulk result and lets another approved member restore the selected files', async () => {
    const one = await add('one.html');
    const two = await add('two.html');
    const missing = crypto.randomUUID();
    const moved = await manageFiles(env, bob, 'trash', [one.id, missing, two.id]);
    expect(moved.results.map(result => result.ok)).toEqual([true, false, true]);
    expect(moved.results[1]!.status).toBe(404);
    expect((await getFile(env, one.id)).trashedBy).toBe(bob.label);
    const restored = await manageFiles(env, bob, 'restore', [one.id, two.id]);
    expect(restored.results.every(result => result.ok)).toBe(true);
    expect((await getFile(env, one.id)).url).toBe(one.url);
  });

  it('validates the whole batch and requires confirmation before any permanent delete', async () => {
    const one = await add('one.html');
    await expect(manageFiles(env, bob, 'trash', [one.id, 'bad-id'])).rejects.toMatchObject({ status: 400 });
    await expect(manageFiles(env, bob, 'trash', [one.id, one.id])).rejects.toMatchObject({ status: 400 });
    await expect(manageFiles(env, bob, 'trash', Array.from({ length: 11 }, () => crypto.randomUUID()))).rejects.toMatchObject({ status: 400 });
    expect((await getFile(env, one.id)).trashedAt).toBeNull();
    await manageFiles(env, bob, 'trash', [one.id]);
    await expect(manageFiles(env, bob, 'delete', [one.id])).rejects.toMatchObject({ status: 400 });
    expect((await getFile(env, one.id)).deletionPending).toBe(false);
    expect((await manageFiles(env, bob, 'delete', [one.id], true)).results[0]!.ok).toBe(true);
    expect((await exports.default.fetch(one.url)).status).toBe(404);
  });

  it('keeps partial permanent failures retryable without restoring missing data', async () => {
    const one = await add('one.html');
    const two = await add('two.html');
    await manageFiles(env, bob, 'trash', [one.id, two.id]);
    const failingEnv = { ...env, FILES: { delete: async (key: string) => {
      if (key === `${one.uploadId}/${one.path}`) throw new Error('Simulated storage failure');
      await env.FILES.delete(key);
    } } as unknown as R2Bucket };
    expect((await manageFiles(failingEnv, bob, 'delete', [one.id, two.id], true)).results.map(result => result.ok)).toEqual([false, true]);
    expect((await getFile(env, one.id)).deletionPending).toBe(true);
    expect((await manageFiles(env, bob, 'restore', [one.id])).results[0]!.status).toBe(409);
    expect((await manageFiles(env, bob, 'delete', [one.id, two.id], true)).results.every(result => result.ok)).toBe(true);
  });

  it('serves PDF inline and protects the new HTTP endpoints', async () => {
    const pdf = await add('sample.pdf');
    const response = await exports.default.fetch(pdf.url);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Disposition')).toContain('inline');
    expect(new TextDecoder().decode(await response.arrayBuffer())).toContain('%PDF-1.4');
    const filters = await exports.default.fetch('http://localhost:8787/api/files/filters');
    expect(filters.status).toBe(200);
    const search = await exports.default.fetch('http://localhost:8787/api/files?q=sample&type=application%2Fpdf');
    expect((await search.json() as { total: number }).total).toBe(1);
    const blocked = await exports.default.fetch('http://localhost:8787/api/files/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example.test' },
      body: JSON.stringify({ action: 'trash', ids: [pdf.id] }),
    });
    expect(blocked.status).toBe(403);
    expect((await getFile(env, pdf.id)).trashedAt).toBeNull();
    expect((await exports.default.fetch('http://localhost:8787/api/files?type=bad')).status).toBe(400);
  });
});
