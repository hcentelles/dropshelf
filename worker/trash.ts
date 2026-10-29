import type { Principal, SharedFile } from '../shared/types';
import { getFile, objectKeyHash } from './files';
import { present, type FileRow } from './file-record';
import { HttpError } from './http';

export async function trashFile(env: Env, user: Principal, id: string): Promise<SharedFile> {
  const row = await env.DB.prepare(`UPDATE files
    SET status = 'trashed', trashed_at = ?, trashed_by_id = ?, trashed_by_label = ?
    WHERE id = ? AND status = 'ready' AND trashed_at IS NULL AND delete_started_at IS NULL
    RETURNING *`).bind(Date.now(), user.id, user.label, id).first<FileRow>();
  if (row) return present(row, env);
  const file = await getFile(env, id);
  if (file.deletionPending) throw new HttpError(409, 'Permanent deletion has started. Retry the permanent delete.');
  if (file.trashedAt !== null) return file;
  throw new HttpError(409, 'The file changed. Reload the list and try again.');
}

export async function restoreFile(env: Env, id: string): Promise<SharedFile> {
  const row = await env.DB.prepare(`UPDATE files
    SET status = 'ready', trashed_at = NULL, trashed_by_id = NULL, trashed_by_label = NULL
    WHERE id = ? AND status = 'trashed' AND delete_started_at IS NULL
    RETURNING *`).bind(id).first<FileRow>();
  if (row) return present(row, env);
  const file = await getFile(env, id);
  if (file.deletionPending) throw new HttpError(409, 'Permanent deletion has started. This file cannot be restored.');
  if (file.trashedAt === null) return file;
  throw new HttpError(409, 'The file changed. Reload the list and try again.');
}

export async function deleteFilePermanently(env: Env, id: string, confirmed: boolean): Promise<{ id: string; deleted: true }> {
  if (confirmed !== true) throw new HttpError(400, 'Confirm permanent deletion with confirm: true.');
  // Once deletion starts, restore must stay blocked even if R2 or D1 fails.
  const row = await env.DB.prepare(`UPDATE files SET status = 'deleting', delete_started_at = COALESCE(delete_started_at, ?)
    WHERE id = ? AND status IN ('trashed', 'deleting') RETURNING *`)
    .bind(Date.now(), id).first<FileRow>();
  if (!row) {
    const deleted = await env.DB.prepare('SELECT id FROM deleted_files WHERE id = ?').bind(id).first();
    if (deleted) return { id, deleted: true };
    await getFile(env, id);
    throw new HttpError(409, 'Move the file to Trash before you delete it permanently.');
  }
  await env.FILES.delete(row.object_key);
  // Keep only a path hash and file ID. Old links and late delete retries must
  // never target a new file uploaded under the same group and relative path.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO deleted_files (id, object_key_hash) VALUES (?, ?) ON CONFLICT DO NOTHING')
      .bind(row.id, await objectKeyHash(row.object_key)),
    env.DB.prepare("DELETE FROM files WHERE id = ? AND status = 'deleting'").bind(row.id),
  ]);
  return { id, deleted: true };
}
