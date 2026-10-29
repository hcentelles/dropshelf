import type { FileFilters, FileFilterOptions, FilePage, FileView } from '../shared/types';
import { fileTypeLabel } from '../shared/formats';
import { present, type FileRow } from './file-record';
import { HttpError } from './http';

function base(view: FileView): string {
  if (view === 'files') return "status = 'ready' AND trashed_at IS NULL AND delete_started_at IS NULL";
  if (view === 'trash') return "status IN ('trashed', 'deleting')";
  throw new HttpError(400, 'Use the files or trash view.');
}

function normalize(input: FileFilters): Required<FileFilters> {
  const q = input.q?.trim().normalize('NFC') ?? '';
  const type = input.type?.trim().toLowerCase() ?? '';
  const author = input.author?.trim() ?? '';
  if (q.length > 200 || author.length > 256 || type.length > 100 ||
    (type && !/^[a-z0-9][a-z0-9.+-]*\/(?:\*|[a-z0-9][a-z0-9.+-]*)$/.test(type))) {
    throw new HttpError(400, 'The file search or filter is not valid.');
  }
  return { q, type, author };
}

function encode(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}

function decode(value: string): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(value), char => char.charCodeAt(0))));
}

export async function listFiles(env: Env, cursor: string | null, limit = 30, view: FileView = 'files', input: FileFilters = {}): Promise<FilePage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'Use a limit from 1 to 100.');
  const filters = normalize(input);
  const key = JSON.stringify([filters.q, filters.type, filters.author]);
  const noFilters = !filters.q && !filters.type && !filters.author;
  let where = base(view);
  const params: Array<string | number> = [];
  if (filters.q) {
    where += " AND name LIKE ? ESCAPE '\\'";
    params.push(`%${filters.q.replace(/[\\%_]/g, char => `\\${char}`)}%`);
  }
  if (filters.type) {
    where += filters.type.endsWith('/*') ? ' AND content_type LIKE ?' : ' AND content_type = ?';
    params.push(filters.type.endsWith('/*') ? `${filters.type.slice(0, -1)}%` : filters.type);
  }
  if (filters.author) { where += ' AND uploader_id = ?'; params.push(filters.author); }
  let point: [number, string] | undefined;
  if (cursor) {
    try {
      const value = decode(cursor);
      if (!Array.isArray(value)) throw new Error();
      let parts = value;
      if (noFilters && value.length === 2 && view === 'files') parts = [view, key, ...value];
      if (noFilters && value.length === 3) parts = [value[0], key, value[1], value[2]];
      if (parts.length !== 4 || parts[0] !== view || parts[1] !== key || !Number.isSafeInteger(parts[2]) ||
        typeof parts[3] !== 'string' || !/^[0-9a-f-]{36}$/.test(parts[3])) throw new Error();
      point = [parts[2] as number, parts[3]];
    } catch { throw new HttpError(400, 'The page cursor does not match this search and view.'); }
  }
  const date = view === 'trash' ? 'trashed_at' : 'created_at';
  const page = env.DB.prepare(`SELECT * FROM files WHERE ${where}${point ? ` AND (${date}, id) < (?, ?)` : ''} ORDER BY ${date} DESC, id DESC LIMIT ?`)
    .bind(...params, ...(point ?? []), limit + 1);
  const [rows, count] = await Promise.all([
    page.all<FileRow>(), env.DB.prepare(`SELECT COUNT(*) AS total FROM files WHERE ${where}`).bind(...params).first<{ total: number }>(),
  ]);
  const files = rows.results.slice(0, limit);
  const last = files.at(-1);
  return {
    files: files.map(row => present(row, env)), total: count?.total ?? 0,
    nextCursor: rows.results.length > limit && last ? encode([view, key, view === 'trash' ? last.trashed_at : last.created_at, last.id]) : null,
  };
}

export async function getFileFilters(env: Env, view: FileView = 'files'): Promise<FileFilterOptions> {
  const where = base(view);
  const [types, authors] = await Promise.all([
    env.DB.prepare(`SELECT content_type, COUNT(*) AS count FROM files WHERE ${where} GROUP BY content_type`).all<{ content_type: string; count: number }>(),
    env.DB.prepare(`SELECT uploader_id, MAX(uploader_label) AS label, COUNT(*) AS count FROM files WHERE ${where} GROUP BY uploader_id ORDER BY label COLLATE NOCASE, uploader_id`).all<{ uploader_id: string; label: string; count: number }>(),
  ]);
  const grouped = new Map<string, number>();
  for (const row of types.results) {
    const value = row.content_type.startsWith('image/') ? 'image/*' : row.content_type;
    grouped.set(value, (grouped.get(value) ?? 0) + row.count);
  }
  return {
    total: types.results.reduce((sum, row) => sum + row.count, 0),
    types: [...grouped].map(([value, count]) => ({ value, label: fileTypeLabel(value), count })).sort((a, b) => a.label.localeCompare(b.label, 'en')),
    authors: authors.results.map(row => ({ value: row.uploader_id, label: row.label, count: row.count })),
  };
}
