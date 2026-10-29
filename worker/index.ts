import type { AppConfig, FileSort, FileView } from '../shared/types';
import { authenticate } from './auth';
import { serveContent } from './content';
import { createUpload, getFile, listFiles, thumbnail, uploadFile } from './files';
import { allowedFileTypes, checkBrowserOrigin, HttpError, isLoopback, json, maxFileBytes, origins, readBody, readJson, secureResponse } from './http';
import { handleMcp, MAX_MCP_BODY } from './mcp';
import { deleteFilePermanently, restoreFile, trashFile } from './trash';
import { getFileFilters } from './file-query';
import { manageFiles } from './bulk';
import type { BulkAction } from '../shared/types';

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { app, content } = origins(env);
  if (url.origin !== app.origin && url.origin !== content.origin) {
    throw new HttpError(403, 'This hostname is not configured for this instance.');
  }
  const user = await authenticate(request, env);
  if (url.origin === content.origin) return serveContent(request, env);
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
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json({ name: env.APP_NAME, user, maxFileBytes: maxFileBytes(env), allowedFileTypes: allowedFileTypes(env),
        mcpUrl: `${app.origin}/mcp`, local: isLoopback(url.hostname) } satisfies AppConfig);
    }
    if (url.pathname === '/api/files' && request.method === 'GET') {
      return json(await listFiles(env, url.searchParams.get('cursor'),
        url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        (url.searchParams.get('view') ?? 'files') as FileView,
        { q: url.searchParams.get('q') ?? '', type: url.searchParams.get('type') ?? '', author: url.searchParams.get('author') ?? '',
          sort: (url.searchParams.get('sort') ?? 'newest') as FileSort }));
    }
    if (url.pathname === '/api/files/filters' && request.method === 'GET') {
      return json(await getFileFilters(env, (url.searchParams.get('view') ?? 'files') as FileView));
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
    const upload = /^\/api\/uploads\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (upload && request.method === 'PUT') {
      const length = request.headers.get('Content-Length');
      if (!length || !/^\d+$/.test(length)) throw new HttpError(411, 'Content-Length is required.');
      const path = url.searchParams.get('path');
      if (!path) throw new HttpError(400, 'A relative file path is required.');
      return json(await uploadFile(env, user, {
        uploadId: upload[1]!, path, type: request.headers.get('Content-Type') ?? '',
        size: Number(length), body: request.body ?? new Uint8Array(), source: 'web',
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
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    headers.set('X-Frame-Options', 'DENY');
    return new Response(response.body, { status: response.status, headers });
  }
  throw new HttpError(404, 'The page was not found.');
}

export default {
  async fetch(request, env, ctx) {
    try { return secureResponse(await route(request, env, ctx)); }
    catch (error) {
      if (error instanceof HttpError) return secureResponse(json({ error: error.message }, error.status));
      console.error(JSON.stringify({ event: 'request_failed', path: new URL(request.url).pathname,
        message: error instanceof Error ? error.message : 'Unknown error' }));
      return secureResponse(json({ error: 'The request failed. Try again.' }, 500));
    }
  },
} satisfies ExportedHandler<Env>;
