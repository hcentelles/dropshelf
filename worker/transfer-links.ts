import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { acceptFile } from '../shared/formats';
import type { Principal, ReplaceFile, SharedFile } from '../shared/types';
import { serveTransferAttachment } from './content';
import { createUpload, uploadFile } from './files';
import { allowedFileTypes, cleanFolder, cleanPath, HttpError, json, maxFileBytes, origins, readJson } from './http';
import { shelf } from './shelf-client';

export const TRANSFER_PREFIX = '/transfer/';
const LIFETIME_SECONDS = 10 * 60;
const TOKEN_TYPE = 'dropshelf-transfer+jwt';
const MAX_BATCH_FILES = 256;
const MAX_BATCH_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const manifestSchema = z.strictObject({
  files: z.array(z.strictObject({
    path: z.string().min(1).max(1024),
    contentType: z.string().max(100).optional(),
    sizeBytes: z.number().int().nonnegative(),
  })).min(1).max(MAX_BATCH_FILES),
});

interface UploadLinkInput {
  path: string;
  contentType?: string;
  sizeBytes?: number;
  uploadId?: string;
  replace?: ReplaceFile;
}

export type UploadBatchGrant = { method: 'POST'; user: Principal; uploadId: string; folder: string };
export interface BatchFileGrant {
  id: string;
  path: string;
  contentType: string;
  sizeBytes: number;
}

export type TransferGrant = UploadBatchGrant
  | ({ method: 'PUT'; user: Principal; uploadId: string; contentType: string } & UploadLinkInput)
  | { method: 'GET'; userId: string; fileId: string; version: number };

function signingKey(env: Env): Uint8Array | null {
  const key = env.TRANSFER_SIGNING_KEY;
  if (!key || !env.TRANSFER_ORIGIN) return null;
  if (!/^[a-f0-9]{64}$/.test(key)) throw new HttpError(503, 'Transfer links are not configured.');
  return new TextEncoder().encode(key);
}

async function signLink(key: Uint8Array | CryptoKey, origin: string, method: TransferGrant['method'], id: string, expiration: number) {
  const token = await new SignJWT({ method })
    .setProtectedHeader({ alg: 'HS256', typ: TOKEN_TYPE })
    .setAudience(origin).setJti(id).setExpirationTime(expiration).sign(key);
  return `${origin}${TRANSFER_PREFIX}${token}`;
}

async function issueLink(env: Env, key: Uint8Array, grant: TransferGrant) {
  const origin = origins(env).transfer!.origin;
  const id = crypto.randomUUID();
  const expiration = Math.floor(Date.now() / 1000) + LIFETIME_SECONDS;
  const url = await signLink(key, origin, grant.method, id, expiration);
  await shelf(env).issueTransfer(id, grant, expiration * 1000);
  return { url, expiresAt: new Date(expiration * 1000).toISOString() };
}

export async function prepareUploadLink(env: Env, user: Principal, input: UploadLinkInput) {
  const key = signingKey(env);
  if (!key) throw new HttpError(503, 'Transfer links are not configured. Open the Drop Shelf upload page.');
  const path = cleanPath(input.path);
  const contentType = acceptFile(path, input.contentType ?? '', allowedFileTypes(env));
  if (!contentType) throw new HttpError(415, 'This file type is not enabled for this instance.');
  const maxBytes = maxFileBytes(env);
  if (input.sizeBytes !== undefined && input.sizeBytes > maxBytes) throw new HttpError(413, 'The file exceeds the size limit.');
  const uploadId = input.uploadId ?? await createUpload(env, user);
  const { url, expiresAt } = await issueLink(env, key, { ...input, path, contentType, uploadId, user, method: 'PUT' });
  return {
    path, uploadId, uploadUrl: url, method: 'PUT', expiresAt,
    headers: { 'Content-Type': contentType },
    usage: `curl -q -fsS --upload-file '<local-file>' --header 'Content-Type: ${contentType}' --url '${url}'`,
  };
}

export async function prepareDownloadLink(env: Env, user: Principal, file: SharedFile) {
  const { id, name, path, contentType, size, version, downloadUrl } = file;
  const details = { id, name, path, contentType, size };
  const key = signingKey(env);
  if (!key) return { ...details, downloadUrl };
  const { url, expiresAt } = await issueLink(env, key, { method: 'GET', userId: user.id, fileId: id, version });
  return {
    ...details, version, downloadUrl: url, browserDownloadUrl: downloadUrl, method: 'GET', expiresAt,
    usage: `curl -q -fsS --output '<local-file>' --url '${url}'`,
  };
}

export async function prepareUploadBatch(env: Env, user: Principal, value: string, existingUploadId?: string) {
  const key = signingKey(env);
  if (!key) throw new HttpError(503, 'Transfer links are not configured. Open the Drop Shelf upload page.');
  const folder = cleanFolder(value);
  const uploadId = existingUploadId ?? await createUpload(env, user);
  const { url, expiresAt } = await issueLink(env, key, { method: 'POST', user, uploadId, folder });
  return {
    folder, uploadId, uploadUrl: url, method: 'POST', expiresAt, headers: { 'Content-Type': 'application/json' },
    maxBatchFiles: MAX_BATCH_FILES, maxBatchBytes: MAX_BATCH_BYTES,
    usage: 'In a local script, POST JSON { "files": [{ "path": "subfolder/file.json", "sizeBytes": 123, "contentType": "application/json" }] } to uploadUrl. Use paths relative to folder. For each entry in the HTTP response, PUT the original local file bytes to its uploadUrl with its returned headers. Keep this response and file bytes in the script. Both steps use the signed URLs. To retry incomplete files, request a new batch link with the same folder and uploadId.',
  };
}

async function exchangeBatch(request: Request, env: Env, url: URL, key: Uint8Array, id: string): Promise<Response> {
  const store = shelf(env);
  const grant = await store.getUploadBatch(id);
  if (!grant) throw invalidLink();

  const manifest = manifestSchema.safeParse(await readJson(request, MAX_MANIFEST_BYTES));
  if (!manifest.success) throw new HttpError(400, `Send 1 to ${MAX_BATCH_FILES} files with a relative path and sizeBytes, and an optional contentType.`);
  const allowed = allowedFileTypes(env);
  const maxBytes = maxFileBytes(env);
  const paths = new Set<string>();
  let bytes = 0;
  const files = manifest.data.files.map(file => {
    const relativePath = cleanPath(file.path);
    const path = cleanPath(`${grant.folder}/${relativePath}`);
    if (paths.has(relativePath)) throw new HttpError(400, 'The batch must contain unique file paths.');
    paths.add(relativePath);
    bytes += file.sizeBytes;
    if (file.sizeBytes > maxBytes) throw new HttpError(413, 'A file exceeds the size limit.');
    if (bytes > MAX_BATCH_BYTES) throw new HttpError(413, 'The batch exceeds the total size limit.');
    const contentType = acceptFile(path, file.contentType ?? '', allowed);
    if (!contentType) throw new HttpError(415, 'A file type in the batch is not enabled for this instance.');
    return { id: crypto.randomUUID(), path, contentType, sizeBytes: file.sizeBytes, relativePath: file.path };
  });
  const expiration = Math.floor(Date.now() / 1000) + LIFETIME_SECONDS;
  const signing = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const links = await Promise.all(files.map(async ({ id: fileId, relativePath, contentType, sizeBytes }) => ({
    path: relativePath, sizeBytes,
    uploadUrl: await signLink(signing, url.origin, 'PUT', fileId, expiration),
    headers: { 'Content-Type': contentType },
  })));
  if (!await store.exchangeUploadBatch(id, files, expiration * 1000)) throw invalidLink();
  return json({
    uploadId: grant.uploadId, folder: grant.folder, expiresAt: new Date(expiration * 1000).toISOString(),
    method: 'PUT', files: links,
  });
}

function invalidLink(): HttpError {
  return new HttpError(403, 'The transfer link is invalid, expired, or already used. Request a new link.');
}

async function verifyLink(env: Env, url: URL) {
  const key = signingKey(env);
  const token = url.pathname.slice(TRANSFER_PREFIX.length);
  if (!key || !/^[A-Za-z0-9_.-]{1,1024}$/.test(token)) throw invalidLink();
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'], typ: TOKEN_TYPE, audience: url.origin, requiredClaims: ['exp', 'jti'],
    });
    return { payload, key };
  } catch { throw invalidLink(); }
}

export async function handleTransfer(request: Request, env: Env, url: URL): Promise<Response> {
  const { payload: { jti, method }, key } = await verifyLink(env, url);
  if (!jti || (method !== 'GET' && method !== 'PUT' && method !== 'POST')) throw invalidLink();
  if (request.method !== method) return new Response('Use the HTTP method from the tool result.', { status: 405, headers: { Allow: method } });
  if (method === 'POST') return exchangeBatch(request, env, url, key, jti);

  const store = shelf(env);
  if (method === 'GET') {
    const grant = await store.consumeTransfer(jti, method);
    if (grant?.method !== 'GET') throw invalidLink();
    const file = await store.readyFile(grant.fileId);
    if (file.version !== grant.version) throw new HttpError(409, 'The file changed. Request a new download link.');
    return serveTransferAttachment(env, file);
  }

  const length = request.headers.get('Content-Length');
  if (!length || !/^\d+$/.test(length)) throw new HttpError(411, 'Content-Length is required.');
  const size = Number(length);
  if (size > maxFileBytes(env)) throw new HttpError(413, 'The file exceeds the size limit.');
  const grant = await store.consumeTransfer(jti, method);
  if (grant?.method !== 'PUT') throw invalidLink();
  if (grant.sizeBytes !== undefined && size !== grant.sizeBytes) throw new HttpError(400, 'The file size differs from the size in the tool call.');
  if (request.headers.get('Content-Type') !== grant.contentType) throw new HttpError(415, 'Use the Content-Type from the tool result.');

  const file = await uploadFile(env, grant.user, {
    uploadId: grant.uploadId, path: grant.path, type: grant.contentType, size,
    body: request.body ?? new Uint8Array(), source: 'mcp', replace: grant.replace,
  });
  const { id, uploadId, path, contentType, version } = file;
  return json({ id, uploadId, path, contentType, size: file.size, version }, 201);
}
