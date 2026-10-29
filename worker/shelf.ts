import { DurableObject } from 'cloudflare:workers';
import type { FileQuery, FileScope, FileView, Principal, SharedFile } from '../shared/types';
import { queryExplorer } from './explorer';
import { objectKeyHash, present, type FileRow, type UploadMetadata } from './file-record';
import { queryFileFilters, queryFiles } from './file-query';
import { cleanPath, HttpError } from './http';
import { initializeSchema } from './schema';

// One object owns the metadata and live connections for one private shelf.
// The Workers stream file bodies directly to and from R2.
export class Shelf extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeSchema(ctx.storage);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  fetch(request: Request): Response {
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('A WebSocket connection is required.', { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send('refresh');
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  listFiles(cursor: string | null, limit = 30, view: FileView = 'files', input: FileQuery = {}) {
    return queryFiles(this.ctx.storage.sql, this.env, cursor, limit, view, input);
  }

  listExplorer(cursor: string | null, limit = 30, view: FileView = 'files', input: FileQuery = {}) {
    return queryExplorer(this.ctx.storage.sql, this.env, cursor, limit, view, input);
  }

  getFileFilters(view: FileView = 'files', scope: FileScope = {}) {
    return queryFileFilters(this.ctx.storage.sql, view, scope);
  }

  createUpload(user: Principal): string {
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec('INSERT INTO uploads (id, owner_id, created_at) VALUES (?, ?, ?)', id, user.id, Date.now());
    return id;
  }

  getFile(id: string): SharedFile { return present(this.#file(id), this.env); }

  async reserveUpload(user: Principal, input: UploadMetadata): Promise<FileRow> {
    const path = cleanPath(input.path);
    const upload = this.ctx.storage.sql.exec<{ owner_id: string }>('SELECT owner_id FROM uploads WHERE id = ?', input.uploadId).toArray()[0];
    if (!upload) throw new HttpError(404, 'The upload was not found.');
    if (upload.owner_id !== user.id) throw new HttpError(403, 'This upload belongs to another user.');
    const row: FileRow = {
      id: crypto.randomUUID(), upload_id: input.uploadId, path, name: path.split('/').at(-1)!,
      object_key: `${input.uploadId}/${path}`, content_type: input.contentType, size: input.size,
      uploader_email: user.email, uploader_label: user.label, source: input.source, created_at: Date.now(),
      trashed_at: null, trashed_by_id: null, trashed_by_label: null, delete_started_at: null,
    };
    const hash = await objectKeyHash(row.object_key);
    const reserved = this.ctx.storage.sql.exec<{ id: string }>(`INSERT INTO files
      (id, upload_id, path, name, object_key, content_type, size, uploader_id, uploader_email, uploader_label, source, status, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?
      WHERE NOT EXISTS (SELECT 1 FROM deleted_files WHERE object_key_hash = ?)
      ON CONFLICT(upload_id, path) DO NOTHING RETURNING id`,
    row.id, row.upload_id, row.path, row.name, row.object_key, row.content_type, row.size,
    user.id, row.uploader_email, row.uploader_label, row.source, row.created_at, hash).toArray();
    if (!reserved.length) throw new HttpError(409, 'This file path is already used. Start a new upload group to use it again.');
    return row;
  }

  completeUpload(id: string): SharedFile {
    const row = this.ctx.storage.sql.exec<FileRow>("UPDATE files SET status = 'ready' WHERE id = ? AND status = 'uploading' RETURNING *", id).toArray()[0];
    if (!row) return this.getFile(id);
    this.#broadcast();
    return present(row, this.env);
  }

  abortUpload(id: string): string | null {
    return this.ctx.storage.sql.exec<{ object_key: string }>("SELECT object_key FROM files WHERE id = ? AND status = 'uploading'", id).toArray()[0]?.object_key ?? null;
  }

  releaseUpload(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM files WHERE id = ? AND status = 'uploading'", id);
  }

  findContent(uploadId: string, path: string): FileRow {
    const row = this.ctx.storage.sql.exec<FileRow>(`SELECT * FROM files WHERE upload_id = ? AND path = ?
      AND status = 'ready' AND trashed_at IS NULL AND delete_started_at IS NULL`, uploadId, cleanPath(path)).toArray()[0];
    if (!row) throw new HttpError(404, 'The file was not found.');
    return row;
  }

  readyFile(id: string): FileRow {
    const row = this.ctx.storage.sql.exec<FileRow>(`SELECT * FROM files WHERE id = ?
      AND status = 'ready' AND trashed_at IS NULL AND delete_started_at IS NULL`, id).toArray()[0];
    if (!row) throw new HttpError(404, 'The file was not found.');
    return row;
  }

  trashFile(user: Principal, id: string): SharedFile {
    const row = this.ctx.storage.sql.exec<FileRow>(`UPDATE files
      SET status = 'trashed', trashed_at = ?, trashed_by_id = ?, trashed_by_label = ?
      WHERE id = ? AND status = 'ready' AND trashed_at IS NULL AND delete_started_at IS NULL RETURNING *`,
    Date.now(), user.id, user.label, id).toArray()[0];
    if (row) { this.#broadcast(); return present(row, this.env); }
    const file = this.getFile(id);
    if (file.deletionPending) throw new HttpError(409, 'Permanent deletion has started. Retry the permanent delete.');
    if (file.trashedAt !== null) return file;
    throw new HttpError(409, 'The file changed. Reload the list and try again.');
  }

  restoreFile(id: string): SharedFile {
    const row = this.ctx.storage.sql.exec<FileRow>(`UPDATE files
      SET status = 'ready', trashed_at = NULL, trashed_by_id = NULL, trashed_by_label = NULL
      WHERE id = ? AND status = 'trashed' AND delete_started_at IS NULL RETURNING *`, id).toArray()[0];
    if (row) { this.#broadcast(); return present(row, this.env); }
    const file = this.getFile(id);
    if (file.deletionPending) throw new HttpError(409, 'Permanent deletion has started. This file cannot be restored.');
    if (file.trashedAt === null) return file;
    throw new HttpError(409, 'The file changed. Reload the list and try again.');
  }

  beginDelete(id: string, confirmed: boolean): string | null {
    if (confirmed !== true) throw new HttpError(400, 'Confirm permanent deletion with confirm: true.');
    const row = this.ctx.storage.sql.exec<FileRow>(`UPDATE files SET status = 'deleting', delete_started_at = COALESCE(delete_started_at, ?)
      WHERE id = ? AND status IN ('trashed', 'deleting') RETURNING *`, Date.now(), id).toArray()[0];
    if (row) { this.#broadcast(); return row.object_key; }
    if (this.ctx.storage.sql.exec('SELECT id FROM deleted_files WHERE id = ?', id).toArray().length) return null;
    this.#file(id);
    throw new HttpError(409, 'Move the file to Trash before you delete it permanently.');
  }

  async finishDelete(id: string): Promise<void> {
    const row = this.ctx.storage.sql.exec<FileRow>("SELECT * FROM files WHERE id = ? AND status = 'deleting'", id).toArray()[0];
    if (!row) {
      if (this.ctx.storage.sql.exec('SELECT id FROM deleted_files WHERE id = ?', id).toArray().length) return;
      throw new HttpError(409, 'Permanent deletion has not started.');
    }
    const hash = await objectKeyHash(row.object_key);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO deleted_files (id, object_key_hash) VALUES (?, ?) ON CONFLICT DO NOTHING', id, hash);
      this.ctx.storage.sql.exec("DELETE FROM files WHERE id = ? AND status = 'deleting'", id);
    });
    this.#broadcast();
  }

  webSocketMessage(socket: WebSocket): void { socket.close(1008, 'This connection is read only.'); }
  webSocketClose(socket: WebSocket): void { this.#close(socket); }
  webSocketError(socket: WebSocket): void { this.#close(socket); }

  #file(id: string): FileRow {
    const row = this.ctx.storage.sql.exec<FileRow>("SELECT * FROM files WHERE id = ? AND status IN ('ready', 'trashed', 'deleting')", id).toArray()[0];
    if (!row) throw new HttpError(404, 'The file was not found.');
    return row;
  }

  #broadcast(): void {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send('refresh'); } catch { this.#close(socket); }
    }
  }

  #close(socket: WebSocket): void {
    try { socket.close(1000, 'Connection closed.'); } catch { /* Already closed. */ }
  }
}
