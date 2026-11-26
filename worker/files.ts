import { acceptFile } from '../shared/formats';
import type { ExplorerPage, FileFilterOptions, FilePage, FileQuery, FileScope, FileView, Principal, ReplaceFile, SharedFile, UploadCheck } from '../shared/types';
import type { FileRow } from './file-record';
import { allowedFileTypes, cleanPath, HttpError, maxFileBytes } from './http';
import { shelf } from './shelf-client';
import type { RetentionMode } from '../shared/retention';

export async function createUpload(env: Env, user: Principal): Promise<string> { return shelf(env).createUpload(user); }
export async function checkUploads(env: Env, paths: string[]): Promise<UploadCheck[]> { return shelf(env).checkUploads(paths); }
export async function getFile(env: Env, id: string): Promise<SharedFile> { return shelf(env).getFile(id); }
export async function getFileWithRetention(env: Env, id: string) { return shelf(env).getFileWithRetention(id); }
export async function setPermanent(env: Env, id: string, permanent: boolean) { return shelf(env).setPermanent(id, permanent); }
export async function setFileRetention(env: Env, id: string, mode: RetentionMode) {
  return shelf(env).setRetention(id, mode);
}
export async function listFiles(env: Env, cursor: string | null, limit = 30, view: FileView = 'files', input: FileQuery = {}): Promise<FilePage> {
  return shelf(env).listFiles(cursor, limit, view, input);
}
export async function listFilesWithRetention(env: Env, cursor: string | null, limit = 30, view: FileView = 'files', input: FileQuery = {}) {
  return shelf(env).listFilesWithRetention(cursor, limit, view, input);
}
export async function listExplorer(env: Env, cursor: string | null, limit = 30, view: FileView = 'files', input: FileQuery = {}): Promise<ExplorerPage> {
  return shelf(env).listExplorer(cursor, limit, view, input);
}
export async function getFileFilters(env: Env, view: FileView = 'files', scope: FileScope = {}): Promise<FileFilterOptions> {
  return shelf(env).getFileFilters(view, scope);
}

interface UploadInput {
  uploadId: string;
  path: string;
  type: string;
  size: number;
  body: ReadableStream<Uint8Array> | Uint8Array;
  source: 'web' | 'mcp';
  replace?: ReplaceFile;
}

export async function uploadFile(env: Env, user: Principal, input: UploadInput): Promise<SharedFile> {
  const path = cleanPath(input.path);
  const contentType = acceptFile(path, input.type, allowedFileTypes(env));
  if (!contentType) throw new HttpError(415, 'This file type is not enabled for this instance.');
  if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maxFileBytes(env)) {
    throw new HttpError(413, 'The file exceeds the size limit.');
  }
  if (input.body instanceof Uint8Array && input.body.byteLength !== input.size) {
    throw new HttpError(400, 'The file size does not match its contents.');
  }
  const store = shelf(env);
  const row = await store.reserveUpload(user, { uploadId: input.uploadId, path, contentType, size: input.size, source: input.source, replace: input.replace });
  try {
    if (input.body instanceof Uint8Array) {
      await env.FILES.put(row.object_key, input.body, { httpMetadata: { contentType } });
    } else {
      const stream = new FixedLengthStream(input.size);
      const written = await Promise.allSettled([
        input.body.pipeTo(stream.writable),
        env.FILES.put(row.object_key, stream.readable, { httpMetadata: { contentType } }),
      ]);
      const failed = written.find(item => item.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    return await store.completeUpload(row.id);
  } catch (error) {
    try {
      // A lost RPC response can follow a successful commit. Cancel only an
      // incomplete reservation; never remove bytes from a completed upload.
      const abortedKey = await store.abortUpload(row.id);
      if (abortedKey) {
        // Keep the path reserved until cleanup is complete. A retry must not
        // write a new object that an older cleanup could remove.
        await env.FILES.delete(abortedKey);
        await store.releaseUpload(row.id);
      }
      else {
        const completed = await store.completedUpload(row.id);
        if (completed) return completed;
      }
    } catch {
      console.error(JSON.stringify({ event: 'upload_cleanup_failed', fileId: row.id }));
    }
    throw error;
  }
}

export async function findContent(env: Env, uploadId: string, path: string): Promise<FileRow> {
  return shelf(env).findContent(uploadId, path);
}

export async function thumbnail(env: Env, id: string): Promise<Response> {
  const row = await shelf(env).readyFile(id);
  const safeTypes = ['image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp',
    'image/avif', 'image/bmp', 'image/vnd.microsoft.icon'];
  if (!safeTypes.includes(row.content_type)) throw new HttpError(404, 'No image preview is available.');
  const object = await env.FILES.get(row.object_key);
  if (!object) throw new HttpError(404, 'The image was not found.');
  return new Response(object.body, { headers: {
    'Content-Type': row.content_type, 'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}
