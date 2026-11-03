import { DAY_MS, EXTENDED_RETENTION_DAYS, type RetentionMode } from '../shared/retention';
import { cleanPath, HttpError } from './http';

// File settings use the stable file ID. Folder settings use the shared path,
// so they cover every upload group and files added after the action.
export function setRetention(storage: DurableObjectStorage, id: string, mode: RetentionMode, now: number) {
  if (typeof id !== 'string' || !['30-days', 'permanent'].includes(mode)) {
    throw new HttpError(400, 'Choose Extend 30 days or Make permanent.');
  }
  const folder = id.startsWith('folder:');
  if (!folder && !/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'The item ID is not valid.');
  const folderPath = folder ? cleanPath(id.slice('folder:'.length)) : '';
  return storage.transactionSync(() => {
    const sql = storage.sql;
    let path: string;
    if (folder) {
      path = folderPath;
      if (!sql.exec(`SELECT id FROM files WHERE status = 'ready'
        AND substr(path, 1, length(?) + 1) = ? || '/' LIMIT 1`, path, path).toArray().length) {
        throw new HttpError(404, 'The folder was not found.');
      }
      // A folder action replaces all settings below it in one transaction.
      // Search filters and pagination must never reduce the affected scope.
      sql.exec("DELETE FROM retention_settings WHERE substr(path, 1, length(?) + 1) = ? || '/'", path, path);
    } else {
      const row = sql.exec<{ path: string }>("SELECT path FROM files WHERE id = ? AND status = 'ready'", id).toArray()[0];
      if (!row) throw new HttpError(404, 'The active file was not found.');
      path = row.path;
    }
    const key = folder ? `folder:${path}` : id;
    sql.exec(`INSERT INTO retention_settings (id, path, kind, mode, changed_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, changed_at = excluded.changed_at`,
    key, path, folder ? 'folder' : 'file', mode, now);
    return { id: key, mode, expiresAt: mode === 'permanent' ? null : now + EXTENDED_RETENTION_DAYS * DAY_MS };
  });
}

export function removeDeletedRetention(sql: SqlStorage, id: string): void {
  sql.exec("DELETE FROM retention_settings WHERE kind = 'file' AND id = ?", id);
  sql.exec(`DELETE FROM retention_settings WHERE kind = 'folder'
    AND NOT EXISTS (SELECT 1 FROM files WHERE substr(files.path, 1, length(retention_settings.path) + 1) = retention_settings.path || '/')
    AND NOT EXISTS (SELECT 1 FROM upload_writes WHERE state = 'uploading'
      AND substr(upload_writes.path, 1, length(retention_settings.path) + 1) = retention_settings.path || '/')`);
}
