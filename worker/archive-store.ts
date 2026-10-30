import { cleanPath, HttpError } from './http';
import type { FileRow } from './file-record';

// Leave room for authentication and metadata requests below the Worker limit.
export const MAX_ARCHIVE_FILES = 5_000;
export type ArchiveFile = Pick<FileRow, 'id' | 'path' | 'object_key' | 'size' | 'updated_at' | 'created_at'>;

export function folderArchiveFiles(sql: SqlStorage, value: string): ArchiveFile[] {
  const path = cleanPath(value);
  if (/^[a-z]:/i.test(path.split('/').at(-1)!)) {
    throw new HttpError(400, 'This folder name cannot be used in a ZIP file.');
  }
  const prefix = `${path}/`;
  // Capture current object keys together. Replacements use new keys, so a
  // download never silently substitutes new bytes for a captured file.
  const files = sql.exec<ArchiveFile>(`SELECT id, path, object_key, size, updated_at, created_at FROM files
    WHERE status = 'ready' AND trashed_at IS NULL AND delete_started_at IS NULL
    AND substr(path, 1, length(?)) = ? ORDER BY path LIMIT ?`, prefix, prefix, MAX_ARCHIVE_FILES + 1).toArray();
  if (!files.length) throw new HttpError(404, 'The folder has no files to download.');
  if (files.length > MAX_ARCHIVE_FILES) {
    throw new HttpError(413, 'A ZIP download can contain up to 5,000 files. Download a smaller folder.');
  }
  return files;
}
