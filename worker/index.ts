import type { AppConfig, FileSort, FileView } from '../shared/types';
import { authenticate } from './auth';
import { serveContent } from './content';
import { checkUploads, createUpload, getFile, listFiles, setFileRetention, thumbnail, uploadFile } from './files';
import { allowedFileTypes, checkBrowserOrigin, HttpError, isHttpError, isLoopback, json, maxFileBytes, origins, readBody, readJson, secureResponse } from './http';
import { handleMcp, MAX_MCP_BODY } from './mcp';
import { deleteFilePermanently, restoreFile, trashFile } from './trash';
import { getFileFilters, listExplorer } from './files';
import { shelf } from './shelf-client';
import { manageFiles } from './bulk';
import type { BulkAction } from '../shared/types';
import { retentionPolicy, type RetentionMode } from '../shared/retention';
import { runRetention } from './retention';
import { handleTransfer, TRANSFER_PREFIX } from './transfer-links';
export { Shelf } from './shelf';

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { app, content, transfer } = origins(env);
  if (url.origin === transfer?.origin && url.pathname.startsWith(TRANSFER_PREFIX)) return handleTransfer(request, env, url);
  if (url.origin !== app.origin && url.origin !== content.origin) {
    throw new HttpError(403, 'This hostname is not configured for this instance.');
  }
  const user = await authenticate(request, env);
  if (url.origin === content.origin) return serveContent(request, env, ctx);
  if (url.pathname === '/mcp') {
    checkBrowserOrigin(request, app.origin);
    if (request.method === 'POST') {
      const body = await readBody(request, MAX_MCP_BODY);
      request = new Request(request.url, { method: 'POST', headers: request.headers, body });
    }
    return handleMcp(request, env, ctx, user);
  }
  if (url.pathname.startsWith('/api/')) {
    checkBrowserOrigin(request, app.origin);
    if (url.pathname === '/api/updates' && request.method === 'GET') {
      return shelf(env).fetch(new Request('https://updates.internal/', {
        headers: { Upgrade: request.headers.get('Upgrade') ?? '' },
      }));
    }
    if (url.pathname === '/api/config' && request.method === 'GET') {
      // Return only public settings. Never serialize the environment or Access configuration.
      return json({ name: env.APP_NAME, user, appOrigin: app.origin, contentOrigin: content.origin,
        transferOrigin: transfer?.origin,
        maxFileBytes: maxFileBytes(env), allowedFileTypes: allowedFileTypes(env),
        mcpUrl: `${app.origin}/mcp`, local: isLoopback(url.hostname), retention: retentionPolicy(env) } satisfies AppConfig);
    }
    if ((url.pathname === '/api/files' || url.pathname === '/api/explorer') && request.method === 'GET') {
      const list = url.pathname === '/api/explorer' ? listExplorer : listFiles;
      return json(await list(env, url.searchParams.get('cursor'),
        url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        (url.searchParams.get('view') ?? 'files') as FileView,
        { q: url.searchParams.get('q') ?? '', type: url.searchParams.get('type') ?? '', author: url.searchParams.get('author') ?? '',
          sort: (url.searchParams.get('sort') ?? 'newest') as FileSort,
          uploadId: url.searchParams.get('uploadId') ?? '', folder: url.searchParams.get('folder') ?? '' }));
    }
    if (url.pathname === '/api/files/filters' && request.method === 'GET') {
      return json(await getFileFilters(env, (url.searchParams.get('view') ?? 'files') as FileView,
        { uploadId: url.searchParams.get('uploadId') ?? '', folder: url.searchParams.get('folder') ?? '' }));
    }
    if (url.pathname === '/api/files/retention' && request.method === 'POST') {
      const payload = await readJson(request);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).length !== 2 || !('id' in payload) || !('mode' in payload)) {
        throw new HttpError(400, 'Send an item ID and expiry mode.');
      }
      return json(await setFileRetention(env, payload.id as string, payload.mode as RetentionMode));
    }
    if (url.pathname === '/api/files/bulk' && request.method === 'POST') {
      const payload = await readJson(request);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some(key => !['action', 'ids', 'confirm'].includes(key)) || !('action' in payload) || !('ids' in payload)) {
        throw new HttpError(400, 'Send an action and file IDs.');
      }
      return json(await manageFiles(env, user, payload.action as BulkAction, payload.ids as string[],
        'confirm' in payload && payload.confirm === true));
    }
    const file = /^\/api\/files\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (file && request.method === 'GET') return json(await getFile(env, file[1]!));
    if (file && request.method === 'DELETE') {
      const payload = await readJson(request);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).length !== 1 || !('confirm' in payload) || payload.confirm !== true) {
        throw new HttpError(400, 'Confirm permanent deletion with {"confirm":true}.');
      }
      return json(await deleteFilePermanently(env, file[1]!, true));
    }
    const action = /^\/api\/files\/([0-9a-f-]{36})\/(trash|restore)$/.exec(url.pathname);
    if (action && request.method === 'POST') {
      const payload = await readJson(request);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) {
        throw new HttpError(400, 'Send an empty JSON object. Identity comes from Access.');
      }
      return json(action[2] === 'trash'
        ? await trashFile(env, user, action[1]!) : await restoreFile(env, action[1]!));
    }
    const preview = /^\/api\/files\/([0-9a-f-]{36})\/thumbnail$/.exec(url.pathname);
    if (preview && request.method === 'GET') return thumbnail(env, preview[1]!);
    if (url.pathname === '/api/uploads' && request.method === 'POST') {
      const payload = await readJson(request);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) {
        throw new HttpError(400, 'Send an empty JSON object. Identity comes from Access.');
      }
      return json({ uploadId: await createUpload(env, user) }, 201);
    }
    if (url.pathname === '/api/uploads/check' && request.method === 'POST') {
      const payload = await readJson(request, 512 * 1024);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || !('paths' in payload)) {
        throw new HttpError(400, 'Send the file paths to check.');
      }
      return json(await checkUploads(env, payload.paths as string[]));
    }
    const upload = /^\/api\/uploads\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (upload && request.method === 'PUT') {
      const length = request.headers.get('Content-Length');
      if (!length || !/^\d+$/.test(length)) throw new HttpError(411, 'Content-Length is required.');
      const path = url.searchParams.get('path');
      if (!path) throw new HttpError(400, 'A relative file path is required.');
      return json(await uploadFile(env, user, {
        uploadId: upload[1]!, path, type: request.headers.get('Content-Type') ?? '',
        size: Number(length), body: request.body ?? new Uint8Array(), source: 'web',
        replace: url.searchParams.has('replaceId') || url.searchParams.has('replaceVersion')
          ? { id: url.searchParams.get('replaceId') ?? '', version: Number(url.searchParams.get('replaceVersion')) } : undefined,
      }), 201);
    }
    throw new HttpError(404, 'The API endpoint was not found.');
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (url.pathname === '/' || url.pathname.startsWith('/assets/')) {
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    const socketOrigin = `${app.protocol === 'https:' ? 'wss:' : 'ws:'}//${app.host}`;
    headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' ${socketOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    headers.set('X-Frame-Options', 'DENY');
    return new Response(response.body, { status: response.status, headers });
  }
  throw new HttpError(404, 'The page was not found.');
}

export default {
  async scheduled(_controller, env) {
    const result = await runRetention(env);
    console.log(JSON.stringify({ event: 'retention_completed', ...result }));
    if (result.failed) throw new Error(`Retention could not delete ${result.failed} files. The next run will retry them.`);
  },
  async fetch(request, env, ctx) {
    try { return secureResponse(await route(request, env, ctx)); }
    catch (error) {
      const path = new URL(request.url).pathname;
      const transfer = path.startsWith(TRANSFER_PREFIX);
      if (isHttpError(error)) return secureResponse(json({ error: error.message, ...(transfer ? {} : error.details) }, error.status));
      console.error(JSON.stringify({ event: 'request_failed', path: transfer ? TRANSFER_PREFIX : path,
        ...(transfer ? {} : { message: error instanceof Error ? error.message : 'Unknown error' }) }));
      return secureResponse(json({ error: 'The request failed. Try again.' }, 500));
    }
  },
} satisfies ExportedHandler<Env>;
