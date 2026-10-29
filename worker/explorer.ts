import type { ExplorerPage, FileQuery, FileView, SharedFolder } from '../shared/types';
import { present, type FileRow } from './file-record';
import { decode, encode, normalize, normalizeScope, scopedWhere } from './file-query';
import { HttpError } from './http';

type EntryRow = FileRow & {
  entry_id: string;
  entry_name: string;
  entry_path: string;
  folder_rank: number;
  entry_size: number;
  file_count: number;
  entry_created: number;
  entry_trashed: number | null;
  entry_actor: string | null;
  entry_pending: number;
  entry_date: number;
};

export function queryExplorer(sql: SqlStorage, env: Env, cursor: string | null, limit = 30,
  view: FileView = 'files', input: FileQuery = {}): ExplorerPage {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'Use a limit from 1 to 100.');
  const sort = input.sort ?? 'newest';
  if (!['newest', 'oldest', 'name'].includes(sort)) throw new HttpError(400, 'Use newest, oldest, or name for sorting.');
  const scope = normalizeScope(input);
  const filters = normalize(input);
  const key = JSON.stringify([scope.uploadId, scope.folder, filters.q, filters.type, filters.author, sort]);
  const { where, params, prefix } = scopedWhere(view, scope);
  const matches: string[] = [];
  const matchParams: string[] = [];
  if (filters.q) {
    matches.push("relative_path LIKE ? ESCAPE '\\'");
    matchParams.push(`%${filters.q.replace(/[\\%_]/g, char => `\\${char}`)}%`);
  }
  if (filters.type) {
    matches.push(filters.type.endsWith('/*') ? 'content_type LIKE ?' : 'content_type = ?');
    matchParams.push(filters.type.endsWith('/*') ? `${filters.type.slice(0, -1)}%` : filters.type);
  }
  if (filters.author) { matches.push('uploader_id = ?'); matchParams.push(filters.author); }

  // Group every visible descendant before paging. A folder is one item even when
  // its files span many pages. Filters select folders without changing their totals.
  const cte = `WITH scoped AS (
    SELECT *, substr(path, length(?) + 1) AS relative_path FROM files WHERE ${where}
  ), named AS (
    SELECT *, CASE WHEN instr(relative_path, '/') > 0 THEN 0 ELSE 1 END AS folder_rank,
      CASE WHEN instr(relative_path, '/') > 0
        THEN substr(relative_path, 1, instr(relative_path, '/') - 1) ELSE name END AS entry_name
    FROM scoped
  ), tagged AS (
    SELECT *, CASE WHEN folder_rank = 0 THEN 'folder:' || upload_id || ':' || ? || entry_name ELSE id END AS entry_id,
      ? || entry_name AS entry_path, CASE WHEN ${matches.join(' AND ') || '1'} THEN 1 ELSE 0 END AS matches
    FROM named
  ), grouped AS (
    SELECT entry_id, entry_name, entry_path, folder_rank, MIN(id) AS record_id,
      SUM(size) AS entry_size, COUNT(*) AS file_count, MAX(created_at) AS entry_created,
      MAX(trashed_at) AS entry_trashed, MAX(delete_started_at IS NOT NULL) AS entry_pending,
      CASE WHEN COUNT(DISTINCT trashed_by_id) > 1 THEN 'Multiple users' ELSE MAX(trashed_by_label) END AS entry_actor,
      MAX(${view === 'trash' ? 'trashed_at' : 'created_at'}) AS entry_date, MAX(matches) AS matches
    FROM tagged GROUP BY entry_id
  )`;
  const bindings = [prefix, ...params, prefix, prefix, ...matchParams];
  let point: [number, number | string, string] | undefined;
  if (cursor) {
    try {
      const value = decode(cursor);
      if (!Array.isArray(value) || value.length !== 5 || value[0] !== view || value[1] !== key ||
        ![0, 1].includes(value[2]) || typeof value[4] !== 'string' || !value[4] || value[4].length > 1100 ||
        (sort === 'name' ? typeof value[3] !== 'string' || !value[3] || value[3].length > 255 : !Number.isSafeInteger(value[3]))) {
        throw new Error();
      }
      point = [value[2], value[3], value[4]];
    } catch { throw new HttpError(400, 'The page cursor does not match this folder, search, sort order, and view.'); }
  }
  const column = sort === 'name' ? 'entry_name COLLATE NOCASE' : 'entry_date';
  const direction = sort === 'newest' ? 'DESC' : 'ASC';
  const comparison = sort === 'newest' ? '<' : '>';
  const position = point ? ` AND (folder_rank > ? OR (folder_rank = ? AND (${column}, entry_id) ${comparison} (?, ?)))` : '';
  const rows = sql.exec<EntryRow>(`${cte} SELECT f.*, g.* FROM grouped g JOIN files f ON f.id = g.record_id
    WHERE g.matches = 1${position} ORDER BY folder_rank ASC, ${column} ${direction}, entry_id ${direction} LIMIT ?`,
    ...bindings, ...(point ? [point[0], ...point] : []), limit + 1).toArray();
  const count = sql.exec<{ total: number }>(`${cte} SELECT COUNT(*) AS total FROM grouped WHERE matches = 1`, ...bindings).one();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    entries: page.map(row => row.folder_rank === 1 ? present(row, env) : {
      kind: 'folder', id: row.entry_id, uploadId: row.upload_id, path: row.entry_path, name: row.entry_name,
      size: row.entry_size, fileCount: row.file_count, uploaderLabel: row.uploader_label, source: row.source,
      createdAt: row.entry_created, trashedAt: row.entry_trashed, trashedBy: row.entry_actor,
      deletionPending: !!row.entry_pending,
    } satisfies SharedFolder),
    total: count?.total ?? 0,
    nextCursor: rows.length > limit && last
      ? encode([view, key, last.folder_rank, sort === 'name' ? last.entry_name : last.entry_date, last.entry_id]) : null,
  };
}
