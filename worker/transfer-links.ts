import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { acceptFile } from '../shared/formats';
import type { Principal, ReplaceFile, SharedFile } from '../shared/types';
import { serveTransferAttachment } from './content';
import { createUpload, uploadFile } from './files';
import { allowedFileTypes, cleanPath, HttpError, json, maxFileBytes, origins } from './http';
import { shelf } from './shelf-client';

export const TRANSFER_PREFIX = '/transfer/';
const LIFETIME_SECONDS = 10 * 60;
const TOKEN_TYPE = 'dropshelf-transfer+jwt';

interface UploadLinkInput {
  path: string;
  contentType?: string;
  sizeBytes?: number;
  uploadId?: string;
  replace?: ReplaceFile;
}

export type TransferGrant =
  | ({ method: 'PUT'; user: Principal; uploadId: string; contentType: string } & UploadLinkInput)
  | { method: 'GET'; userId: string; fileId: string; version: number };

function signingKey(env: Env): Uint8Array | null {
  const key = env.TRANSFER_SIGNING_KEY;
  if (!key || !env.TRANSFER_ORIGIN) return null;
  if (!/^[a-f0-9]{64}$/.test(key)) throw new HttpError(503, 'Transfer links are not configured.');
  return new TextEncoder().encode(key);
}

async function issueLink(env: Env, key: Uint8Array, grant: TransferGrant) {
  const origin = origins(env).transfer!.origin;
  const id = crypto.randomUUID();
  const expiration = Math.floor(Date.now() / 1000) + LIFETIME_SECONDS;
  const token = await new SignJWT({ method: grant.method })
    .setProtectedHeader({ alg: 'HS256', typ: TOKEN_TYPE })
    .setAudience(origin).setJti(id).setExpirationTime(expiration).sign(key);
  await shelf(env).issueTransfer(id, grant, expiration * 1000);
  return { url: `${origin}${TRANSFER_PREFIX}${token}`, expiresAt: new Date(expiration * 1000).toISOString() };
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

function invalidLink(): HttpError {
  return new HttpError(403, 'The transfer link is invalid, expired, or already used. Request a new link.');
}

async function verifyLink(env: Env, url: URL): Promise<JWTPayload> {
  const key = signingKey(env);
  const token = url.pathname.slice(TRANSFER_PREFIX.length);
  if (!key || !/^[A-Za-z0-9_.-]{1,1024}$/.test(token)) throw invalidLink();
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'], typ: TOKEN_TYPE, audience: url.origin, requiredClaims: ['exp', 'jti'],
    });
    return payload;
  } catch { throw invalidLink(); }
}

export async function handleTransfer(request: Request, env: Env, url: URL): Promise<Response> {
  const { jti, method } = await verifyLink(env, url);
  if (!jti || (method !== 'GET' && method !== 'PUT')) throw invalidLink();
  if (request.method !== method) return new Response('Use the HTTP method from the tool result.', { status: 405, headers: { Allow: method } });

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
