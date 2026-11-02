import { DAY_MS, EXTENDED_RETENTION_DAYS } from '../shared/retention';

export const RETENTION_DELETE_BATCH = 100;
export type PendingDeletion = { id: string; object_key: string };

// The default expiry unit remains a root file or top-level folder. Explicit
// file settings and the closest folder setting take priority over that default.
const rootPath = "CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1) ELSE path END";
const activityDate = 'MAX(created_at, updated_at, COALESCE(restored_at, 0))';

// Both the explorer and scheduled job use these exact dates. Apply list filters
// only after this calculation, so a hidden descendant cannot change the result.
export function activeRetentionCtes(days: number): string {
  return `active_files AS (
    SELECT *, ${rootPath} AS retention_root, ${activityDate} AS activity_at
    FROM files WHERE status IN ('ready', 'uploading')
  ), root_dates AS (
    SELECT retention_root, MAX(activity_at) AS activity_at FROM active_files GROUP BY retention_root
  ), setting_dates AS (
    SELECT s.id, s.mode, CASE WHEN s.mode = 'permanent' THEN NULL
      ELSE MAX(s.changed_at, COALESCE(MAX(f.activity_at), 0)) + ${EXTENDED_RETENTION_DAYS * DAY_MS} END AS expires_at
    FROM retention_settings s LEFT JOIN active_files f ON
      (s.kind = 'file' AND f.id = s.id) OR
      (s.kind = 'folder' AND substr(f.path, 1, length(s.path) + 1) = s.path || '/')
    GROUP BY s.id
  ), matched_files AS (
    SELECT f.*, (SELECT s.id FROM retention_settings s WHERE
      (s.kind = 'file' AND s.id = f.id) OR
      (s.kind = 'folder' AND substr(f.path, 1, length(s.path) + 1) = s.path || '/')
      ORDER BY length(s.path) DESC LIMIT 1) AS retention_id
    FROM active_files f
  ), retained_files AS (
    SELECT f.*, COALESCE(s.mode = 'permanent', 0) AS permanent,
      CASE WHEN s.id IS NOT NULL THEN s.expires_at
        WHEN ${days} > 0 THEN r.activity_at + ${days * DAY_MS} ELSE NULL END AS expiry_at
    FROM matched_files f JOIN root_dates r ON r.retention_root = f.retention_root
    LEFT JOIN setting_dates s ON s.id = f.retention_id
  )`;
}

export function moveExpiredToTrash(storage: DurableObjectStorage, days: number, now: number): number {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec(`WITH ${activeRetentionCtes(days)}, writing AS (
      SELECT ${rootPath} AS root FROM upload_writes WHERE state = 'uploading'
      UNION SELECT retention_root FROM active_files WHERE status = 'uploading'
    ), due AS (
      SELECT id FROM retained_files WHERE expiry_at <= ? AND permanent = 0
        AND retention_root NOT IN (SELECT root FROM writing)
    )
    UPDATE files SET status = 'trashed', trashed_at = ?,
      trashed_by_id = 'system:retention', trashed_by_label = 'Automatic expiry'
    WHERE status = 'ready' AND id IN (SELECT id FROM due)`, now, now);
    return sql.exec<{ count: number }>('SELECT changes() AS count').one().count;
  });
}

export function beginExpiredDeletion(storage: DurableObjectStorage, days: number, now: number): PendingDeletion[] {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const rows = sql.exec<PendingDeletion>(`SELECT id, object_key FROM files
      WHERE status IN ('trashed', 'deleting')
        AND (status = 'deleting' OR (? > 0 AND trashed_at <= ?))
      ORDER BY trashed_at, id LIMIT ?`, days, now - days * DAY_MS, RETENTION_DELETE_BATCH).toArray();
    // Claim deletion in the same transaction as the date check. A restore or
    // a new move to Trash cannot invalidate that check before R2 deletion.
    for (const row of rows) {
      sql.exec(`UPDATE files SET status = 'deleting', delete_started_at = COALESCE(delete_started_at, ?)
        WHERE id = ?`, now, row.id);
    }
    return rows;
  });
}
