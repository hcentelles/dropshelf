import { findContent } from './files';
import { HttpError } from './http';
import { downloadFolder } from './archive';
import type { FileRow } from './file-record';

function fileDisposition(name: string, mode: 'attachment' | 'inline'): string {
  const encodedName = encodeURIComponent(name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`);
  return `${mode}; filename*=UTF-8''${encodedName}`;
}

export async function serveTransferAttachment(env: Env, file: FileRow): Promise<Response> {
  const object = await env.FILES.get(file.object_key);
  if (!object) throw new HttpError(404, 'The stored file was not found.');
  return new Response(object.body, { headers: {
    'Content-Type': file.content_type,
    'Content-Disposition': fileDisposition(file.name, 'attachment'),
    'Content-Length': String(object.size),
    'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
  } });
}

export async function serveContent(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const url = new URL(request.url);
  if (url.pathname === '/folders.zip' && request.method === 'GET') return downloadFolder(request, env, ctx);
  const match = /^\/f\/([0-9a-f-]{36})\/(.+)$/.exec(url.pathname);
  if (!match) throw new HttpError(404, 'The file was not found.');
  let path: string;
  try { path = decodeURIComponent(match[2]!); }
  catch { throw new HttpError(400, 'The file URL is not valid.'); }
  const row = await findContent(env, match[1]!, path);
  let object: R2Object | null;
  let body: ReadableStream | null = null;
  if (request.method === 'HEAD') object = await env.FILES.head(row.object_key);
  else {
    const stored = await env.FILES.get(row.object_key);
    object = stored;
    body = stored?.body ?? null;
  }
  if (!object) throw new HttpError(404, 'The stored file was not found.');
  const headers = new Headers({
    'Content-Type': !url.searchParams.has('download') && ['text/markdown', 'text/csv'].includes(row.content_type)
      ? 'text/plain; charset=utf-8' : row.content_type,
    'ETag': object.httpEtag,
    'X-Frame-Options': 'DENY',
    // Files have their own origin and cannot connect to the application API.
    'Content-Security-Policy': "default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' https: 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  });
  headers.set('Content-Disposition', fileDisposition(row.name,
    url.searchParams.has('download') || row.content_type === 'application/zip' ? 'attachment' : 'inline'));
  headers.set('Content-Length', String(object.size));
  if (request.headers.get('If-None-Match') === object.httpEtag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}
