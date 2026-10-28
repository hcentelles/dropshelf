import { findContent } from './files';
import { HttpError } from './http';

export async function serveContent(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const url = new URL(request.url);
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
  const name = encodeURIComponent(row.name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`);
  headers.set('Content-Disposition', `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`);
  headers.set('Content-Length', String(object.size));
  if (request.headers.get('If-None-Match') === object.httpEtag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}
