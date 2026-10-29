import type { Principal } from '../shared/types';
import type { UploadMetadata } from '../worker/file-record';
import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { createUpload, getFile, uploadFile } from '../worker/files';
import { shelf } from '../worker/shelf-client';
import { deleteFilePermanently, restoreFile, trashFile } from '../worker/trash';
import { database, resetDatabase } from './database';
import worker from '../worker/index';

beforeEach(resetDatabase);
const user = { id: 'local-developer', email: 'developer@example.test', label: 'Developer', kind: 'user' as const };
const body = new TextEncoder().encode('<h1>Live test</h1>');
const input = (uploadId: string, path = 'site/page.html') => ({ uploadId, path, type: 'text/html', size: body.length, body, source: 'web' as const });

async function connect() {
  const response = await exports.default.fetch('http://localhost:8787/api/updates', {
    headers: { Upgrade: 'websocket', Origin: 'http://localhost:8787' },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: unknown[] = [];
  socket.addEventListener('message', event => { messages.push(event.data); });
  socket.accept();
  await expect.poll(() => messages).toContain('refresh');
  return { socket, messages };
}

it('keeps metadata, owner checks, Trash, and deletion records after the object restarts', async () => {
  const uploadId = await createUpload(env, user);
  const file = await uploadFile(env, user, input(uploadId));
  const deleted = await uploadFile(env, user, input(uploadId, 'removed.html'));
  await trashFile(env, user, file.id);
  await trashFile(env, user, deleted.id);
  await deleteFilePermanently(env, deleted.id, true);
  await evictDurableObject(shelf(env));
  expect((await getFile(env, file.id)).trashedAt).not.toBeNull();
  expect((await restoreFile(env, file.id)).url).toBe(file.url);
  expect(await (await exports.default.fetch(file.url)).text()).toBe(new TextDecoder().decode(body));
  await expect(uploadFile(env, { ...user, id: 'other-user' }, input(uploadId, 'other.html'))).rejects.toMatchObject({ status: 403 });
  await expect(uploadFile(env, user, input(uploadId, deleted.path))).rejects.toMatchObject({ status: 409 });
  expect(await deleteFilePermanently(env, deleted.id, true)).toEqual({ id: deleted.id, deleted: true });
  expect(await database(sql => sql.exec('SELECT version FROM schema_migrations').toArray())).toEqual([{ version: 1 }]);
});

it('notifies two pages after HTTP and MCP changes, including after hibernation', async () => {
  const first = await connect();
  const second = await connect();
  try {
    const uploadId = await createUpload(env, user);
    const file = await uploadFile(env, user, input(uploadId));
    for (const page of [first, second]) await expect.poll(() => page.messages.length).toBe(2);
    await evictDurableObject(shelf(env));
    first.socket.send('ping');
    await expect.poll(() => first.messages.at(-1)).toBe('pong');
    const moved = await exports.default.fetch(`http://localhost:8787/api/files/${file.id}/trash`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(moved.status).toBe(200);
    await expect.poll(() => second.messages.length).toBe(3);
    expect((await getFile(env, file.id)).trashedAt).not.toBeNull();
    const restored = await exports.default.fetch('http://localhost:8787/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Host: 'localhost:8787' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'restore_file', arguments: { id: file.id } } }),
    });
    expect(restored.status).toBe(200);
    await restored.text();
    await expect.poll(() => second.messages.length).toBe(4);
    expect((await getFile(env, file.id)).trashedAt).toBeNull();
    await trashFile(env, user, file.id);
    await deleteFilePermanently(env, file.id, true);
    await expect.poll(() => second.messages.length).toBe(7);
    expect(await database(sql => sql.exec('SELECT id FROM files').toArray())).toEqual([]);
  } finally { first.socket.close(); second.socket.close(); }
});

it('rejects cross-site sockets and unsigned remote requests, and blocks client broadcasts', async () => {
  expect((await exports.default.fetch('http://localhost:8787/api/updates', {
    headers: { Upgrade: 'websocket', Origin: 'https://other.example.test' },
  })).status).toBe(403);
  expect((await exports.default.fetch('http://localhost:8787/api/updates')).status).toBe(426);
  const remote = { ...env, APP_ORIGIN: 'https://app.example.test', CONTENT_ORIGIN: 'https://content.example.test', LOCAL_DEV_EMAIL: '', ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'example-audience' };
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  expect((await worker.fetch(new Request('https://app.example.test/api/updates', { headers: { Upgrade: 'websocket' } }), remote, ctx)).status).toBe(401);
  const page = await connect();
  const closed = new Promise<CloseEvent>(resolve => { page.socket.addEventListener('close', resolve, { once: true }); });
  page.socket.send('refresh');
  expect((await closed).code).toBe(1008);
});

it('keeps a failed upload path reserved until R2 cleanup is complete and then permits a retry', async () => {
  const uploadId = await createUpload(env, user);
  let reservedDuringCleanup = false;
  const failingEnv = { ...env, FILES: {
    put: async () => { throw new Error('Upload failed'); },
    delete: async () => {
      await expect(uploadFile(env, user, input(uploadId))).rejects.toMatchObject({ status: 409 });
      reservedDuringCleanup = true;
    },
  } as unknown as R2Bucket };
  await expect(uploadFile(failingEnv, user, input(uploadId))).rejects.toThrow('Upload failed');
  expect(reservedDuringCleanup).toBe(true);
  const retried = await uploadFile(env, user, input(uploadId));
  expect((await exports.default.fetch(retried.url)).status).toBe(200);
});

it('does not remove completed file bytes after the completion response is lost', async () => {
  const uploadId = await createUpload(env, user);
  // Commit the upload, then emulate a lost response at the RPC boundary.
  const stub = shelf(env);
  const failingEnv = { ...env, SHELF: {
    getByName: () => ({
      reserveUpload: async (owner: Principal, metadata: UploadMetadata) => stub.reserveUpload(owner, metadata),
      completeUpload: async (id: string) => { await stub.completeUpload(id); throw new Error('Lost response'); },
      abortUpload: async (id: string) => stub.abortUpload(id),
      getFile: async (id: string) => stub.getFile(id),
    }),
  } as unknown as Env['SHELF'] };
  const file = await uploadFile(failingEnv, user, input(uploadId));
  expect(await (await exports.default.fetch(file.url)).text()).toBe(new TextDecoder().decode(body));
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM files WHERE id = ?', file.id).one().status).toBe('ready');
  });
});
