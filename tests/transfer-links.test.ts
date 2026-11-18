import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { decodeJwt, decodeProtectedHeader, SignJWT } from 'jose';
import { expect, it } from 'vitest';
import type { Principal, SharedFile } from '../shared/types';
import { uploadFile } from '../worker/files';
import worker from '../worker/index';
import { prepareDownloadLink, prepareUploadLink } from '../worker/transfer-links';

const configured = {
  ...env, APP_ORIGIN: 'https://app.example.test', CONTENT_ORIGIN: 'https://content.example.test',
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
