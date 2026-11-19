import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { decodeJwt, decodeProtectedHeader, SignJWT } from 'jose';
import { expect, it } from 'vitest';
import type { Principal, SharedFile } from '../shared/types';
import { uploadFile } from '../worker/files';
import worker from '../worker/index';
import { prepareDownloadLink, prepareUploadBatch, prepareUploadLink } from '../worker/transfer-links';

const configured = {
  ...env, APP_ORIGIN: 'https://app.example.test', CONTENT_ORIGIN: 'https://content.example.test',
  TRANSFER_ORIGIN: 'https://transfer.example.test',
  ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'test-audience', LOCAL_DEV_EMAIL: '',
  TRANSFER_SIGNING_KEY: 'a1'.repeat(32),
};
const user: Principal = { id: 'user:test', kind: 'user', email: 'member@example.test', label: 'Test member' };
const body = new TextEncoder().encode('{}\n');
const call = (url: string, init?: Pick<RequestInit, 'method' | 'body' | 'headers'>) =>
  worker.fetch(new Request(url, init), configured, createExecutionContext());

it('rejects expired and invalid signatures and keeps the rest of the content host private', async () => {
  const link = await prepareUploadLink(configured, user, { path: 'grant-check.json', sizeBytes: body.length });
  const url = new URL(link.uploadUrl);
  const token = url.pathname.split('/').at(-1)!;
  const expired = await new SignJWT(decodeJwt(token)).setProtectedHeader({ alg: 'HS256', typ: decodeProtectedHeader(token).typ })
    .setExpirationTime(1).sign(new TextEncoder().encode(configured.TRANSFER_SIGNING_KEY));
  const put = { method: 'PUT', body, headers: { ...link.headers, 'Content-Length': String(body.length) } };
  for (const value of [expired, `${token}invalid`]) {
    expect((await call(`${url.origin}/transfer/${value}`, put)).status).toBe(403);
  }
  expect((await call(`${configured.APP_ORIGIN}${url.pathname}`, put)).status).toBe(401);
  expect((await call(`${configured.CONTENT_ORIGIN}${url.pathname}`, put)).status).toBe(401);
  expect((await call(`${url.origin}/mcp`)).status).toBe(403);
  const uploaded = await call(link.uploadUrl, put);
  expect(uploaded.status).toBe(201);
  const file = await uploaded.json<SharedFile>();
  expect((await call(`${configured.CONTENT_ORIGIN}/f/${file.uploadId}/${file.path}`)).status).toBe(401);
});

it('binds a download grant to the file version that existed when the tool issued it', async () => {
  const path = 'grant-version.json';
  const link = await prepareUploadLink(configured, user, { path });
  const upload = { uploadId: link.uploadId, path, type: 'application/json', size: body.length, body, source: 'mcp' as const };
  const original = await uploadFile(configured, user, upload);
  const { downloadUrl } = await prepareDownloadLink(configured, user, original);
  await uploadFile(configured, user, { ...upload, replace: { id: original.id, version: original.version } });
  expect((await call(downloadUrl)).status).toBe(409);
  expect((await call(downloadUrl)).status).toBe(403);
});

function submitManifest(url: string, files: unknown[]) {
  return call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) });
}

it('validates the full manifest and lets only one request redeem the batch', async () => {
  const batch = await prepareUploadBatch(configured, user, 'batch-scope/run/');
  const item = { path: 'nested/report.json', sizeBytes: body.length };
  expect(batch.folder).toBe('batch-scope/run');
  expect((await call(batch.uploadUrl)).status).toBe(405);
  expect((await submitManifest(batch.uploadUrl, [item, { ...item, path: '../other.json' }])).status).toBe(400);
  expect((await submitManifest(batch.uploadUrl, [
    { ...item, path: 'caf\u00e9.json' }, { ...item, path: 'cafe\u0301.json' },
  ])).status).toBe(400);
  expect((await submitManifest(batch.uploadUrl, [item, { ...item, path: 'unknown.bin' }])).status).toBe(415);
  const bytes = Number(configured.MAX_FILE_BYTES);
  const oversize = Array.from({ length: Math.floor(batch.maxBatchBytes / bytes) + 1 },
    (_, index) => ({ path: `large-${index}.json`, sizeBytes: bytes }));
  expect((await submitManifest(batch.uploadUrl, oversize)).status).toBe(413);

  const responses = await Promise.all([submitManifest(batch.uploadUrl, [item]), submitManifest(batch.uploadUrl, [item])]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 403]);
  const issued = await responses.find(response => response.ok)!.json<{
    uploadId: string; files: { path: string; uploadUrl: string; headers: Record<string, string> }[];
  }>();
  expect(issued.uploadId).toBe(batch.uploadId);
  expect(issued.files).toHaveLength(1);
  const [file] = issued.files;
  expect(file?.path).toBe(item.path);
  const put = { method: 'PUT', body, headers: { ...file!.headers, 'Content-Length': String(body.length) } };
  const uploaded = await call(file!.uploadUrl, put);
  expect(uploaded.status).toBe(201);
  expect(await uploaded.json()).toMatchObject({ path: `${batch.folder}/${item.path}`, uploadId: batch.uploadId });
  expect((await call(file!.uploadUrl, put)).status).toBe(403);
});

it('lets only the batch owner request another link and keeps existing files intact', async () => {
  const folder = 'resume-run';
  const batch = await prepareUploadBatch(configured, user, folder);
  await expect(prepareUploadBatch(configured, { ...user, id: 'other-user' }, folder, batch.uploadId))
    .rejects.toMatchObject({ status: 403 });
  const original = await uploadFile(configured, user, {
    uploadId: batch.uploadId, path: `${folder}/existing.json`, size: 2, type: 'application/json',
    body: new TextEncoder().encode('{}'), source: 'mcp',
  });
  const retry = await prepareUploadBatch(configured, user, folder, batch.uploadId);
  const response = await submitManifest(retry.uploadUrl, [{ path: 'existing.json', sizeBytes: body.length }]);
  const { files } = await response.json<{ files: { uploadUrl: string; headers: Record<string, string> }[] }>();
  const conflict = await call(files[0]!.uploadUrl, {
    method: 'PUT', body, headers: { ...files[0]!.headers, 'Content-Length': String(body.length) },
  });
  expect(conflict.status).toBe(409);
  const download = await prepareDownloadLink(configured, user, original);
  expect(await (await call(download.downloadUrl)).text()).toBe('{}');
});
