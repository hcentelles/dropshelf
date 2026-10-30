import { parseAllowedFileTypes } from '../shared/formats';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: Record<string, unknown>) { super(message); this.name = 'HttpError'; }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof Error && error.name === 'HttpError' && 'status' in error &&
    typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function origins(env: Env): { app: URL; content: URL } {
  const app = new URL(env.APP_ORIGIN);
  const content = new URL(env.CONTENT_ORIGIN);
  for (const url of [app, content]) {
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))) {
      throw new HttpError(503, 'The instance origin is not valid.');
    }
  }
  if (app.origin === content.origin) throw new HttpError(503, 'Use separate app and content origins.');
  return { app, content };
}

export function maxFileBytes(env: Env): number {
  const bytes = Number(env.MAX_FILE_BYTES);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 100 * 1024 * 1024) {
    throw new HttpError(503, 'The file size limit is not valid.');
  }
  return bytes;
}

export function allowedFileTypes(env: Env): string[] {
  try { return parseAllowedFileTypes(env.ALLOWED_FILE_TYPES); }
  catch { throw new HttpError(503, 'The allowed file type setting is not valid.'); }
}

export function checkBrowserOrigin(request: Request, appOrigin: string): void {
  const origin = request.headers.get('Origin');
  if (origin && origin !== appOrigin) throw new HttpError(403, 'This origin is not allowed.');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new HttpError(403, 'Cross-site requests are not allowed.');
  }
}

export function cleanPath(input: string): string {
  const path = input.normalize('NFC');
  // oxlint-disable-next-line no-control-regex -- Reject control characters in uploaded file paths.
  if (!path || path.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(path) || path.startsWith('/')) {
    throw new HttpError(400, 'Use a relative file path.');
  }
  if (path.split('/').some(part => !part || part === '.' || part === '..' || part.length > 255)) {
    throw new HttpError(400, 'The file path contains an invalid part.');
  }
  return path;
}

export async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new HttpError(413, 'The request is too large.');
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, 'The request is too large.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

export async function readJson(request: Request, limit = 16 * 1024): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'Send application/json.');
  }
  try { return JSON.parse(new TextDecoder().decode(await readBody(request, limit))); }
  catch (error) {
    if (isHttpError(error)) throw error;
    throw new HttpError(400, 'The JSON body is not valid.');
  }
}

export function secureResponse(response: Response): Response {
  if (response.webSocket) return response;
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Cache-Control', 'private, no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
