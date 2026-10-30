import type { FileFilters, FileFilterOptions, FilePage, FileQuery, FileScope, FileView } from '../shared/types';
import { fileTypeLabel } from '../shared/formats';
import { present, type FileRow } from './file-record';
import { cleanPath, HttpError } from './http';

export function base(view: FileView): string {
  if (view === 'files') return "status = 'ready' AND trashed_at IS NULL AND delete_started_at IS NULL";
  if (view === 'trash') return "status IN ('trashed', 'deleting')";
  throw new HttpError(400, 'Use the files or trash view.');
}

export function normalize(input: FileFilters): Required<FileFilters> {
  const q = input.q?.trim().normalize('NFC') ?? '';
  const type = input.type?.trim().toLowerCase() ?? '';
  const author = input.author?.trim() ?? '';
  if (q.length > 200 || author.length > 256 || type.length > 100 ||
    (type && !/^[a-z0-9][a-z0-9.+-]*\/(?:\*|[a-z0-9][a-z0-9.+-]*)$/.test(type))) {
    throw new HttpError(400, 'The file search or filter is not valid.');
  }
  return { q, type, author };
}

export function encode(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}

export function decode(value: string): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(value), char => char.charCodeAt(0))));
}

export function normalizeScope(input: FileScope): Required<FileScope> {
  const uploadId = input.uploadId ?? '';
  const folder = input.folder ?? '';
  if (uploadId && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uploadId) || !folder)) {
    throw new HttpError(400, 'The folder scope is not valid.');
  }
  // Old folder links can include an upload ID. The shared tree uses only the path.
  return { uploadId: '', folder: folder ? cleanPath(folder) : '' };
}

export function scopedWhere(view: FileView, scope: Required<FileScope>) {
  const prefix = scope.folder ? `${scope.folder}/` : '';
  return {
    where: base(view) + (prefix ? ' AND substr(path, 1, length(?)) = ?' : ''),
    params: prefix ? [prefix, prefix] : [],
    prefix,
  };
}

export function queryFiles(sql: SqlStorage, env: Env, cursor: string | null, limit = 30, view: FileView = 'files', input: FileQuery = {}): FilePage {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'Use a limit from 1 to 100.');
  const sort = input.sort ?? 'newest';
  if (!['newest', 'oldest', 'name'].includes(sort)) throw new HttpError(400, 'Use newest, oldest, or name for sorting.');
  const filters = normalize(input);
  const scope = normalizeScope(input);
  // Keep existing newest-first cursors valid after deployment.
  const key = JSON.stringify([filters.q, filters.type, filters.author, ...(sort === 'newest' ? [] : [sort]),
    ...(scope.folder ? [scope.folder] : [])]);
  const noFilters = !filters.q && !filters.type && !filters.author && !scope.folder;
  let { where, params } = scopedWhere(view, scope);
  if (filters.q) {
    where += " AND name LIKE ? ESCAPE '\\'";
    params.push(`%${filters.q.replace(/[\\%_]/g, char => `\\${char}`)}%`);
  }
  if (filters.type) {
    where += filters.type.endsWith('/*') ? ' AND content_type LIKE ?' : ' AND content_type = ?';
    params.push(filters.type.endsWith('/*') ? `${filters.type.slice(0, -1)}%` : filters.type);
  }
  if (filters.author) { where += ' AND uploader_id = ?'; params.push(filters.author); }
  let point: [number | string, string] | undefined;
  if (cursor) {
    try {
      const value = decode(cursor);
      if (!Array.isArray(value)) throw new Error();
      let parts = value;
      if (sort === 'newest' && noFilters && value.length === 2 && view === 'files') parts = [view, key, ...value];
      if (sort === 'newest' && noFilters && value.length === 3) parts = [value[0], key, value[1], value[2]];
      const validPosition = sort === 'name'
        ? typeof parts[2] === 'string' && parts[2].length > 0 && parts[2].length <= 1024
        : Number.isSafeInteger(parts[2]);
      if (parts.length !== 4 || parts[0] !== view || parts[1] !== key || !validPosition ||
        typeof parts[3] !== 'string' || !/^[0-9a-f-]{36}$/.test(parts[3])) throw new Error();
      point = [parts[2] as number | string, parts[3]];
    } catch { throw new HttpError(400, 'The page cursor does not match this search, sort order, and view.'); }
  }
  const date = view === 'trash' ? 'trashed_at' : 'COALESCE(NULLIF(updated_at, 0), created_at)';
  const column = sort === 'name' ? 'name COLLATE NOCASE' : date;
  const direction = sort === 'newest' ? 'DESC' : 'ASC';
  const comparison = sort === 'newest' ? '<' : '>';
  const rows = sql.exec<FileRow>(`SELECT * FROM files WHERE ${where}${point ? ` AND (${column}, id) ${comparison} (?, ?)` : ''} ORDER BY ${column} ${direction}, id ${direction} LIMIT ?`,
    ...params, ...(point ?? []), limit + 1).toArray();
  const count = sql.exec<{ total: number }>(`SELECT COUNT(*) AS total FROM files WHERE ${where}`, ...params).one();
  const files = rows.slice(0, limit);
  const last = files.at(-1);
  return {
    files: files.map(row => present(row, env)), total: count?.total ?? 0,
    nextCursor: rows.length > limit && last
      ? encode([view, key, sort === 'name' ? last.name : view === 'trash' ? last.trashed_at : last.updated_at || last.created_at, last.id]) : null,
  };
}

export function queryFileFilters(sql: SqlStorage, view: FileView = 'files', input: FileScope = {}): FileFilterOptions {
  const { where, params } = scopedWhere(view, normalizeScope(input));
  const types = sql.exec<{ content_type: string; count: number }>(
    `SELECT content_type, COUNT(*) AS count FROM files WHERE ${where} GROUP BY content_type`, ...params).toArray();
  const authors = sql.exec<{ uploader_id: string; label: string; count: number }>(
    `SELECT uploader_id, MAX(uploader_label) AS label, COUNT(*) AS count FROM files WHERE ${where} GROUP BY uploader_id ORDER BY label COLLATE NOCASE, uploader_id`, ...params).toArray();
  const grouped = new Map<string, number>();
  for (const row of types) {
    const value = row.content_type.startsWith('image/') ? 'image/*' : row.content_type;
    grouped.set(value, (grouped.get(value) ?? 0) + row.count);
  }
  return {
    total: types.reduce((sum, row) => sum + row.count, 0),
    types: [...grouped].map(([value, count]) => ({ value, label: fileTypeLabel(value), count })).sort((a, b) => a.label.localeCompare(b.label, 'en')),
    authors: authors.map(row => ({ value: row.uploader_id, label: row.label, count: row.count })),
  };
}
