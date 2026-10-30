import { DAY_MS } from '../shared/retention';

export const RETENTION_DELETE_BATCH = 100;
export type PendingDeletion = { id: string; object_key: string };

// A root file or top-level folder is one expiry unit. Keep an HTML page and
// its assets together, including files added in different upload groups.
const rootPath = "CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1) ELSE path END";
const activityDate = 'MAX(created_at, updated_at, COALESCE(restored_at, 0))';

export function retentionRoot(path: string): string { return path.split('/')[0]!; }

export function activeExpiryDates(sql: SqlStorage, paths: string[], days: number): Map<string, number> {
  if (!days || !paths.length) return new Map();
  const roots = [...new Set(paths.map(retentionRoot))];
  // Use the whole expiry group, even when the list shows only a filtered page
  // or a nested folder. These are the same dates used by the scheduled job.
  const rows = sql.exec<{ root: string; at: number }>(`SELECT ${rootPath} AS root, MAX(${activityDate}) AS at
    FROM files WHERE status IN ('ready', 'uploading') AND (${rootPath}) IN (${roots.map(() => '?').join(',')})
    GROUP BY root`, ...roots).toArray();
  return new Map(rows.map(row => [row.root, row.at + days * DAY_MS]));
}

export function moveExpiredToTrash(storage: DurableObjectStorage, days: number, now: number): number {
  if (days === 0) return 0;
  return storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec(`WITH due AS (
      SELECT ${rootPath} AS root FROM files WHERE status IN ('ready', 'uploading')
      GROUP BY root
      HAVING MAX(${activityDate}) <= ?
        AND SUM(status = 'uploading') = 0
    ), writing AS (
      SELECT ${rootPath} AS root FROM upload_writes WHERE state = 'uploading'
    )
    UPDATE files SET status = 'trashed', trashed_at = ?,
      trashed_by_id = 'system:retention', trashed_by_label = 'Automatic expiry'
    WHERE status = 'ready' AND (${rootPath}) IN (SELECT root FROM due)
      AND (${rootPath}) NOT IN (SELECT root FROM writing)`, now - days * DAY_MS, now);
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
