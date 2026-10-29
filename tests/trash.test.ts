import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUpload, getFile, listFiles, uploadFile } from '../worker/files';
import { deleteFilePermanently, restoreFile, trashFile } from '../worker/trash';
import { prepareDatabase } from './database';

beforeAll(prepareDatabase);

const owner = { id: 'uploader', email: 'uploader@example.test', label: 'uploader@example.test', kind: 'user' as const };
const member = { id: 'team-member', email: 'member@example.test', label: 'member@example.test', kind: 'user' as const };
const body = new TextEncoder().encode('<h1>Trash test</h1>');

async function add(path = 'page.html') {
  const uploadId = await createUpload(env, owner);
  return uploadFile(env, owner, { uploadId, path, type: 'text/html', size: body.length, body, source: 'web' });
}

const request = (path: string, method: string, payload: unknown, origin?: string) => exports.default.fetch(`http://localhost:8787${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(payload),
});

describe('Trash', () => {
  it('lets another member trash and restore a file without changing its URL or uploader', async () => {
    const file = await add('folder/page.html');
    const trashed = await trashFile(env, member, file.id);
    expect(trashed.trashedBy).toBe(member.label);
    expect(trashed.trashedAt).toBeTypeOf('number');
    expect(trashed.uploaderEmail).toBe(owner.email);
    expect((await listFiles(env, null, 100)).files.some(item => item.id === file.id)).toBe(false);
    expect((await listFiles(env, null, 100, 'trash')).files.some(item => item.id === file.id)).toBe(true);
    expect((await getFile(env, file.id)).trashedAt).toBe(trashed.trashedAt);
    for (const url of [file.url, file.downloadUrl]) {
      expect((await exports.default.fetch(url)).status).toBe(404);
      expect((await exports.default.fetch(url, { method: 'HEAD' })).status).toBe(404);
    }
    expect(await env.FILES.head(`${file.uploadId}/${file.path}`)).not.toBeNull();
    const retry = await trashFile(env, owner, file.id);
    expect(retry.trashedAt).toBe(trashed.trashedAt);
    expect(retry.trashedBy).toBe(member.label);
    const restored = await restoreFile(env, file.id);
    expect(restored.url).toBe(file.url);
    expect(restored.trashedAt).toBeNull();
    expect(restored.uploaderEmail).toBe(owner.email);
    expect(await (await exports.default.fetch(file.url)).text()).toBe(new TextDecoder().decode(body));
    expect((await restoreFile(env, file.id)).url).toBe(file.url);
  });

  it('requires Trash and explicit confirmation before permanent deletion', async () => {
    const file = await add();
    await expect(deleteFilePermanently(env, file.id, false)).rejects.toMatchObject({ status: 400 });
    await expect(deleteFilePermanently(env, file.id, true)).rejects.toMatchObject({ status: 409 });
    expect((await getFile(env, file.id)).deletionPending).toBe(false);
    await trashFile(env, member, file.id);
    await expect(deleteFilePermanently(env, file.id, false)).rejects.toMatchObject({ status: 400 });
    expect(await env.FILES.head(`${file.uploadId}/${file.path}`)).not.toBeNull();
    await deleteFilePermanently(env, file.id, true);
  });

  it('removes bytes and metadata, keeps deletion idempotent, and prevents an old URL from being reused', async () => {
    const file = await add();
    await trashFile(env, member, file.id);
    await Promise.all([deleteFilePermanently(env, file.id, true), deleteFilePermanently(env, file.id, true)]);
    expect(await env.FILES.head(`${file.uploadId}/${file.path}`)).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM files WHERE id = ?').bind(file.id).first()).toBeNull();
    await expect(getFile(env, file.id)).rejects.toMatchObject({ status: 404 });
    expect((await exports.default.fetch(file.url)).status).toBe(404);
    expect(await deleteFilePermanently(env, file.id, true)).toEqual({ id: file.id, deleted: true });
    await expect(uploadFile(env, owner, {
      uploadId: file.uploadId, path: file.path, type: 'text/html', size: body.length, body, source: 'mcp',
    })).rejects.toMatchObject({ status: 409 });
    expect((await exports.default.fetch(file.url)).status).toBe(404);
  });

  it('keeps an R2 deletion failure in Trash and allows a safe retry', async () => {
    const file = await add();
    await trashFile(env, member, file.id);
    const failingEnv = { ...env, FILES: { delete: async () => { throw new Error('R2 test failure'); } } as unknown as R2Bucket };
    await expect(deleteFilePermanently(failingEnv, file.id, true)).rejects.toThrow('R2 test failure');
    expect((await getFile(env, file.id)).deletionPending).toBe(true);
    expect(await env.FILES.head(`${file.uploadId}/${file.path}`)).not.toBeNull();
    await expect(restoreFile(env, file.id)).rejects.toMatchObject({ status: 409 });
    await deleteFilePermanently(env, file.id, true);
    expect(await env.FILES.head(`${file.uploadId}/${file.path}`)).toBeNull();
  });

  it('blocks restore after R2 deletion if the database update fails, then completes on retry', async () => {
    const file = await add();
    await trashFile(env, member, file.id);
    const failingEnv = { ...env, DB: {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async () => { throw new Error('D1 test failure'); },
    } as unknown as D1Database };
    await expect(deleteFilePermanently(failingEnv, file.id, true)).rejects.toThrow('D1 test failure');
    expect(await env.FILES.head(`${file.uploadId}/${file.path}`)).toBeNull();
    expect((await getFile(env, file.id)).deletionPending).toBe(true);
    await expect(restoreFile(env, file.id)).rejects.toMatchObject({ status: 409 });
    await deleteFilePermanently(env, file.id, true);
    await expect(getFile(env, file.id)).rejects.toMatchObject({ status: 404 });
  });

  it('cannot restore a file while a simultaneous permanent delete removes its bytes', async () => {
    for (let index = 0; index < 4; index++) {
      const file = await add();
      await trashFile(env, member, file.id);
      const operations = index % 2
        ? [deleteFilePermanently(env, file.id, true), restoreFile(env, file.id)]
        : [restoreFile(env, file.id), deleteFilePermanently(env, file.id, true)];
      const results = await Promise.allSettled(operations);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const row = await env.DB.prepare('SELECT status FROM files WHERE id = ?').bind(file.id).first<{ status: string }>();
      const object = await env.FILES.head(`${file.uploadId}/${file.path}`);
      if (row) { expect(row.status).toBe('ready'); expect(object).not.toBeNull(); }
      else expect(object).toBeNull();
    }
  });

  it('paginates Trash by its Trash date and rejects cursors from the other view', async () => {
    for (let index = 0; index < 4; index++) await trashFile(env, member, (await add()).id);
    const page = await listFiles(env, null, 2, 'trash');
    expect(page.files).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const added = await add();
    await trashFile(env, member, added.id);
    await env.DB.prepare('UPDATE files SET trashed_at = ? WHERE id = ?').bind(page.files[0]!.trashedAt! + 1000, added.id).run();
    const next = await listFiles(env, page.nextCursor, 2, 'trash');
    expect(next.files).toHaveLength(2);
    const seen = new Set(page.files.map(file => file.id));
    expect(next.files.some(file => seen.has(file.id) || file.id === added.id)).toBe(false);
    await expect(listFiles(env, page.nextCursor, 2, 'files')).rejects.toMatchObject({ status: 400 });
    const active = await listFiles(env, null, 1);
    if (active.nextCursor) await expect(listFiles(env, active.nextCursor, 1, 'trash')).rejects.toMatchObject({ status: 400 });
  });

  it('enforces HTTP confirmation, signed identity, cross-site protection, and thumbnail hiding', async () => {
    const file = await add('image.png');
    for (const [suffix, method, payload] of [
      ['/trash', 'POST', {}], ['/restore', 'POST', {}], ['', 'DELETE', { confirm: true }],
    ] as const) {
      expect((await request(`/api/files/${file.id}${suffix}`, method, payload, 'https://other.example.test')).status).toBe(403);
    }
    expect((await request(`/api/files/${file.id}/trash`, 'POST', { trashedBy: 'spoof@example.test' })).status).toBe(400);
    const trashed = await request(`/api/files/${file.id}/trash`, 'POST', {});
    expect(trashed.status).toBe(200);
    expect((await trashed.json() as { trashedBy: string }).trashedBy).toBe('developer@example.test');
    expect((await exports.default.fetch(`http://localhost:8787/api/files/${file.id}/thumbnail`)).status).toBe(404);
    expect((await request(`/api/files/${file.id}`, 'DELETE', {})).status).toBe(400);
    expect((await request(`/api/files/${file.id}`, 'DELETE', { confirm: false })).status).toBe(400);
    expect((await request(`/api/files/${file.id}/restore`, 'POST', {})).status).toBe(200);
    expect((await exports.default.fetch(file.url)).status).toBe(200);
    await request(`/api/files/${file.id}/trash`, 'POST', {});
    expect((await request(`/api/files/${file.id}`, 'DELETE', { confirm: true })).status).toBe(200);
    expect((await exports.default.fetch(file.url)).status).toBe(404);
  });
});
