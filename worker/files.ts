import { acceptFile } from '../shared/formats';
import type { Principal, SharedFile } from '../shared/types';
import { present, type FileRow } from './file-record';
export { listFiles } from './file-query';
import { allowedFileTypes, cleanPath, HttpError, maxFileBytes } from './http';

export async function createUpload(env: Env, user: Principal): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO uploads (id, owner_id, created_at) VALUES (?, ?, ?)')
    .bind(id, user.id, Date.now()).run();
  return id;
}

export async function getFile(env: Env, id: string): Promise<SharedFile> {
  const row = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND status IN ('ready', 'trashed', 'deleting')")
    .bind(id).first<FileRow>();
  if (!row) throw new HttpError(404, 'The file was not found.');
  return present(row, env);
}

interface UploadInput {
  uploadId: string;
  path: string;
  type: string;
  size: number;
  body: ReadableStream<Uint8Array> | Uint8Array;
  source: 'web' | 'mcp';
}

export async function objectKeyHash(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function uploadFile(env: Env, user: Principal, input: UploadInput): Promise<SharedFile> {
  const path = cleanPath(input.path);
  const contentType = acceptFile(path, input.type, allowedFileTypes(env));
  if (!contentType) throw new HttpError(415, 'This file type is not enabled for this instance.');
  if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maxFileBytes(env)) {
    throw new HttpError(413, 'The file exceeds the size limit.');
  }
  const upload = await env.DB.prepare('SELECT owner_id FROM uploads WHERE id = ?')
    .bind(input.uploadId).first<{ owner_id: string }>();
  if (!upload) throw new HttpError(404, 'The upload was not found.');
  if (upload.owner_id !== user.id) throw new HttpError(403, 'This upload belongs to another user.');
  const row: FileRow = {
    id: crypto.randomUUID(), upload_id: input.uploadId, path,
    name: path.split('/').at(-1)!, object_key: `${input.uploadId}/${path}`,
    content_type: contentType, size: input.size, uploader_email: user.email,
    uploader_label: user.label, source: input.source, created_at: Date.now(),
    trashed_at: null, trashed_by_id: null, trashed_by_label: null, delete_started_at: null,
  };
  // Reserve the path before writing R2. Concurrent requests cannot replace a file.
  const reserved = await env.DB.prepare(`INSERT INTO files
    (id, upload_id, path, name, object_key, content_type, size, uploader_id,
      uploader_email, uploader_label, source, status, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?
    WHERE NOT EXISTS (SELECT 1 FROM deleted_files WHERE object_key_hash = ?)
    ON CONFLICT(upload_id, path) DO NOTHING`)
    .bind(row.id, row.upload_id, row.path, row.name, row.object_key, row.content_type,
      row.size, user.id, row.uploader_email, row.uploader_label, row.source, row.created_at,
      await objectKeyHash(row.object_key)).run();
  if (!reserved.meta.changes) throw new HttpError(409, 'This file path is already used. Start a new upload group to use it again.');
  try {
    if (input.body instanceof Uint8Array) {
      await env.FILES.put(row.object_key, input.body, { httpMetadata: { contentType } });
    } else {
      // R2 requires a known stream length. This also rejects truncated or oversized bodies.
      const stream = new FixedLengthStream(input.size);
      const written = await Promise.allSettled([
        input.body.pipeTo(stream.writable),
        env.FILES.put(row.object_key, stream.readable, { httpMetadata: { contentType } }),
      ]);
      const failed = written.find(item => item.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    await env.DB.prepare("UPDATE files SET status = 'ready' WHERE id = ?").bind(row.id).run();
    return present(row, env);
  } catch (error) {
    // Keep incomplete objects out of the file list. The reserved path can be retried.
    const cleanup = await Promise.allSettled([
      env.FILES.delete(row.object_key),
      env.DB.prepare('DELETE FROM files WHERE id = ?').bind(row.id).run(),
    ]);
    if (cleanup.some(result => result.status === 'rejected')) {
      console.error(JSON.stringify({ event: 'upload_cleanup_failed', fileId: row.id }));
    }
    throw error;
  }
}

export async function findContent(env: Env, uploadId: string, path: string): Promise<FileRow> {
  const row = await env.DB.prepare("SELECT * FROM files WHERE upload_id = ? AND path = ? AND status = 'ready' AND trashed_at IS NULL AND delete_started_at IS NULL")
    .bind(uploadId, cleanPath(path)).first<FileRow>();
  if (!row) throw new HttpError(404, 'The file was not found.');
  return row;
}

export async function thumbnail(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND status = 'ready' AND trashed_at IS NULL AND delete_started_at IS NULL")
    .bind(id).first<FileRow>();
  const safeTypes = ['image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp',
    'image/avif', 'image/bmp', 'image/vnd.microsoft.icon'];
  if (!row || !safeTypes.includes(row.content_type)) throw new HttpError(404, 'No image preview is available.');
  const object = await env.FILES.get(row.object_key);
  if (!object) throw new HttpError(404, 'The image was not found.');
  // SVG and HTML must never be served from the application origin.
  return new Response(object.body, { headers: {
    'Content-Type': row.content_type, 'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}
