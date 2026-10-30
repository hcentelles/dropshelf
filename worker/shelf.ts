import { DurableObject } from 'cloudflare:workers';
import type { FileQuery, FileScope, FileView, Principal, SharedFile } from '../shared/types';
import { queryExplorer } from './explorer';
import { objectKeyHash, present, type FileRow, type UploadMetadata } from './file-record';
import { queryFileFilters, queryFiles } from './file-query';
import { cleanPath, HttpError } from './http';
import { initializeSchema } from './schema';
import { UploadStore } from './upload-store';
import { retentionPolicy } from '../shared/retention';
import { beginExpiredDeletion, moveExpiredToTrash } from './retention-store';
import { folderArchiveFiles } from './archive-store';

// One object owns the metadata and live connections for one private shelf.
// The Workers stream file bodies directly to and from R2.
export class Shelf extends DurableObject<Env> {
  private uploads: UploadStore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeSchema(ctx.storage);
    this.uploads = new UploadStore(ctx.storage, env);
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

  folderArchiveFiles(folder: string) { return folderArchiveFiles(this.ctx.storage.sql, folder); }

  getFileFilters(view: FileView = 'files', scope: FileScope = {}) {
    return queryFileFilters(this.ctx.storage.sql, view, scope);
  }

  createUpload(user: Principal): string {
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec('INSERT INTO uploads (id, owner_id, created_at) VALUES (?, ?, ?)', id, user.id, Date.now());
    return id;
  }

  getFile(id: string): SharedFile { return present(this.#file(id), this.env); }

  checkUploads(paths: string[]) { return this.uploads.check(paths); }
  async reserveUpload(user: Principal, input: UploadMetadata) { return this.uploads.reserve(user, input); }
  async completeUpload(id: string): Promise<SharedFile> {
    const file = await this.uploads.complete(id);
    this.#broadcast();
    return file;
  }
  completedUpload(id: string): SharedFile | null { return this.uploads.completed(id); }
  abortUpload(id: string): string | null { return this.uploads.abort(id); }
  releaseUpload(id: string): void { this.uploads.release(id); }
  async alarm(): Promise<void> { await this.uploads.cleanup(); }

  expireFiles(): number {
    const count = moveExpiredToTrash(this.ctx.storage, retentionPolicy(this.env).fileDays, Date.now());
    if (count) this.#broadcast();
    return count;
  }

  beginExpiredDeletion() {
    const files = beginExpiredDeletion(this.ctx.storage, retentionPolicy(this.env).trashDays, Date.now());
    if (files.length) this.#broadcast();
    return files;
  }

  async findContent(uploadId: string, value: string): Promise<FileRow> {
    const path = cleanPath(value);
    const sql = this.ctx.storage.sql;
    const link = sql.exec<{ file_id: string }>('SELECT file_id FROM file_links WHERE upload_id = ? AND path = ?', uploadId, path).toArray()[0];
    if (link) return this.readyFile(link.file_id);
    // Relative HTML assets can now come from any upload in the merged folder.
    // Exact legacy links, including deleted links, never change their target.
    if (!sql.exec('SELECT id FROM uploads WHERE id = ?', uploadId).toArray().length ||
      sql.exec('SELECT id FROM deleted_files WHERE object_key_hash = ?', await objectKeyHash(`${uploadId}/${path}`)).toArray().length) {
      throw new HttpError(404, 'The file was not found.');
    }
    const row = sql.exec<FileRow>("SELECT * FROM files WHERE path = ? AND status = 'ready'", path).toArray()[0];
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
    this.uploads.assertNotWriting(id);
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
    this.uploads.assertRestorable(this.#file(id));
    const row = this.ctx.storage.sql.exec<FileRow>(`UPDATE files
      SET status = 'ready', trashed_at = NULL, trashed_by_id = NULL, trashed_by_label = NULL, restored_at = ?
      WHERE id = ? AND status = 'trashed' AND delete_started_at IS NULL RETURNING *`, Date.now(), id).toArray()[0];
    if (row) { this.#broadcast(); return present(row, this.env); }
    const file = this.getFile(id);
    if (file.deletionPending) throw new HttpError(409, 'Permanent deletion has started. This file cannot be restored.');
    if (file.trashedAt === null) return file;
    throw new HttpError(409, 'The file changed. Reload the list and try again.');
  }

  beginDelete(id: string, confirmed: boolean): string | null {
    if (confirmed !== true) throw new HttpError(400, 'Confirm permanent deletion with confirm: true.');
    this.uploads.assertNotWriting(id);
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
