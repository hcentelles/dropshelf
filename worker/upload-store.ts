import type { Principal, SharedFile, UploadCheck } from '../shared/types';
import { objectKeyHash, present, type FileRow, type UploadMetadata } from './file-record';
import { cleanPath, HttpError } from './http';

type UploadWrite = {
  id: string; upload_id: string; path: string; file_id: string; expected_version: number | null;
  object_key: string; content_type: string; size: number; uploader_id: string; uploader_email: string | null;
  uploader_label: string; source: 'web' | 'mcp'; created_at: number; expires_at: number; state: 'uploading' | 'complete';
};

const WRITE_TIMEOUT = 30 * 60_000;
const CLEANUP_DELAY = 60_000;
const RECEIPT_LIFETIME = 24 * 60 * 60_000;

// All methods run inside Shelf. R2 writes use immutable keys, so a failed or
// delayed upload cannot change the bytes of the file that readers currently see.
export class UploadStore {
  constructor(private storage: DurableObjectStorage, private env: Env) {}

  check(paths: string[]): UploadCheck[] {
    if (!Array.isArray(paths) || !paths.length || paths.length > 100 || paths.some(path => typeof path !== 'string')) {
      throw new HttpError(400, 'Send from 1 to 100 file paths.');
    }
    return paths.map(value => {
      const path = cleanPath(value);
      try {
        this.assertNoWrite(path);
        this.assertNoFolderConflict(path);
        const row = this.current(path);
        if (row?.status === 'uploading') throw new HttpError(409, 'Another upload is using this path. Try again when it finishes.');
        return { path, ...(row ? { existing: present(row, this.env) } : {}) };
      } catch (error) { return { path, error: error instanceof Error ? error.message : 'This path is not available.' }; }
    });
  }

  async reserve(user: Principal, input: UploadMetadata): Promise<UploadWrite> {
    const path = cleanPath(input.path);
    const replace = input.replace;
    if (replace && (!/^[0-9a-f-]{36}$/.test(replace.id) || !Number.isSafeInteger(replace.version) || replace.version < 1)) {
      throw new HttpError(400, 'Replacement requires the current file ID and version.');
    }
    const oldKeyHash = await objectKeyHash(`${input.uploadId}/${path}`);
    const now = Date.now();
    await this.schedule(now + WRITE_TIMEOUT);
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const upload = sql.exec<{ owner_id: string }>('SELECT owner_id FROM uploads WHERE id = ?', input.uploadId).toArray()[0];
      if (!upload) throw new HttpError(404, 'The upload was not found.');
      if (upload.owner_id !== user.id) throw new HttpError(403, 'This upload belongs to another user.');
      this.assertNoWrite(path);
      this.assertNoFolderConflict(path);
      const existing = this.current(path);
      if (existing?.status === 'uploading') throw new HttpError(409, 'Another upload is using this path. Try again when it finishes.');
      if (existing && (!replace || replace.id !== existing.id || replace.version !== existing.version)) {
        throw new HttpError(409, replace ? 'The file changed after confirmation. Check the current file before replacing it.'
          : 'A file already exists at this path. Ask before replacing it.', { conflict: present(existing, this.env) });
      }
      if (!existing && replace) throw new HttpError(409, 'The file changed after confirmation. Check the path and try again.');
      const link = sql.exec<{ file_id: string }>('SELECT file_id FROM file_links WHERE upload_id = ? AND path = ?', input.uploadId, path).toArray()[0];
      if ((link && link.file_id !== existing?.id) || sql.exec('SELECT id FROM deleted_files WHERE object_key_hash = ?', oldKeyHash).toArray().length) {
        throw new HttpError(409, 'This upload group has already used this path. Start a new upload group.');
      }
      const id = crypto.randomUUID();
      sql.exec(`INSERT INTO upload_writes
        (id, upload_id, path, file_id, expected_version, object_key, content_type, size,
         uploader_id, uploader_email, uploader_label, source, created_at, expires_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`,
      id, input.uploadId, path, existing?.id ?? id, existing?.version ?? null, `objects/${id}`,
      input.contentType, input.size, user.id, user.email, user.label, input.source, now, now + WRITE_TIMEOUT);
      return sql.exec<UploadWrite>('SELECT * FROM upload_writes WHERE id = ?', id).one();
    });
  }

  async complete(id: string): Promise<SharedFile> {
    await this.schedule(Date.now() + CLEANUP_DELAY);
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const write = sql.exec<UploadWrite>('SELECT * FROM upload_writes WHERE id = ?', id).toArray()[0];
      if (!write) throw new HttpError(409, 'This upload expired. Upload the file again.');
      if (write.state === 'complete') return this.completed(id)!;
      if (write.expires_at <= Date.now()) throw new HttpError(409, 'This upload expired. Upload the file again.');
      const now = Date.now();
      if (write.expected_version !== null) {
        const current = this.current(write.path);
        if (!current || current.id !== write.file_id || current.version !== write.expected_version || current.status !== 'ready') {
          throw new HttpError(409, 'The file changed during the upload. Check it before replacing it.');
        }
        sql.exec(`UPDATE files SET object_key = ?, content_type = ?, size = ?, uploader_id = ?, uploader_email = ?,
          uploader_label = ?, source = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        write.object_key, write.content_type, write.size, write.uploader_id, write.uploader_email, write.uploader_label, write.source, now, current.id);
        sql.exec('INSERT INTO retired_objects (object_key, delete_after) VALUES (?, ?)', current.object_key, now + CLEANUP_DELAY);
      } else {
        sql.exec(`INSERT INTO files (id, upload_id, path, url_path, name, object_key, content_type, size,
          uploader_id, uploader_email, uploader_label, source, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
        write.file_id, write.upload_id, write.path, write.path, write.path.split('/').at(-1)!, write.object_key,
        write.content_type, write.size, write.uploader_id, write.uploader_email, write.uploader_label, write.source, now, now);
      }
      sql.exec('INSERT INTO file_links (upload_id, path, file_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', write.upload_id, write.path, write.file_id);
      sql.exec("UPDATE upload_writes SET state = 'complete', expires_at = ? WHERE id = ?", now + RECEIPT_LIFETIME, id);
      return present(sql.exec<FileRow>('SELECT * FROM files WHERE id = ?', write.file_id).one(), this.env);
    });
  }

  completed(id: string): SharedFile | null {
    const row = this.storage.sql.exec<FileRow>(`SELECT files.* FROM upload_writes JOIN files ON files.id = upload_writes.file_id
      WHERE upload_writes.id = ? AND upload_writes.state = 'complete'`, id).toArray()[0];
    return row ? present(row, this.env) : null;
  }

  abort(id: string): string | null {
    return this.storage.sql.exec<{ object_key: string }>("SELECT object_key FROM upload_writes WHERE id = ? AND state = 'uploading'", id).toArray()[0]?.object_key ?? null;
  }

  release(id: string): void { this.storage.sql.exec("DELETE FROM upload_writes WHERE id = ? AND state = 'uploading'", id); }

  assertNotWriting(fileId: string): void {
    if (this.storage.sql.exec("SELECT id FROM upload_writes WHERE file_id = ? AND state = 'uploading'", fileId).toArray().length) {
      throw new HttpError(409, 'This file is being replaced. Try again when the upload finishes.');
    }
  }

  assertRestorable(file: FileRow): void {
    this.assertNoWrite(file.path);
    this.assertNoFolderConflict(file.path);
    const other = this.current(file.path);
    if (other && other.id !== file.id) throw new HttpError(409, 'A file already uses this path. Move it to Trash before restoring this file.');
  }

  private current(path: string) {
    return this.storage.sql.exec<FileRow & { status: string }>("SELECT * FROM files WHERE path = ? AND status IN ('ready', 'uploading')", path).toArray()[0];
  }

  private assertNoWrite(path: string): void {
    if (this.storage.sql.exec(`SELECT id FROM upload_writes WHERE state = 'uploading' AND
      (path = ? OR substr(path, 1, length(?) + 1) = ? || '/' OR substr(?, 1, length(path) + 1) = path || '/') LIMIT 1`, path, path, path, path).toArray().length) {
      throw new HttpError(409, 'Another upload is using this path. Try again when it finishes.');
    }
  }

  private assertNoFolderConflict(path: string): void {
    if (this.storage.sql.exec(`SELECT id FROM files WHERE status IN ('ready', 'uploading') AND
      (substr(path, 1, length(?) + 1) = ? || '/' OR substr(?, 1, length(path) + 1) = path || '/') LIMIT 1`, path, path, path).toArray().length) {
      throw new HttpError(409, 'A file and a folder cannot use the same path. Choose another name.');
    }
  }

  private async schedule(at: number): Promise<void> {
    const alarm = await this.storage.getAlarm();
    if (alarm === null || alarm > at) await this.storage.setAlarm(at);
  }

  async cleanup(): Promise<void> {
    const sql = this.storage.sql;
    const now = Date.now();
    this.storage.transactionSync(() => {
      sql.exec(`INSERT INTO retired_objects SELECT object_key, ? FROM upload_writes
        WHERE expires_at <= ? AND state = 'uploading' ON CONFLICT DO NOTHING`, now + CLEANUP_DELAY, now);
      sql.exec('DELETE FROM upload_writes WHERE expires_at <= ?', now);
    });
    try {
      const keys = sql.exec<{ object_key: string }>('SELECT object_key FROM retired_objects WHERE delete_after <= ? LIMIT 100', now).toArray().map(row => row.object_key);
      if (keys.length) {
        await this.env.FILES.delete(keys);
        this.storage.transactionSync(() => { for (const key of keys) sql.exec('DELETE FROM retired_objects WHERE object_key = ?', key); });
      }
    } finally {
      const next = sql.exec<{ at: number | null }>(`SELECT MIN(at) AS at FROM (
        SELECT MIN(expires_at) AS at FROM upload_writes UNION ALL SELECT MIN(delete_after) AS at FROM retired_objects
      )`).one().at;
      if (next !== null) await this.storage.setAlarm(Math.max(Date.now() + 30_000, next));
    }
  }
}
