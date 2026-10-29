import { MAX_BULK_FILES, type BulkAction, type BulkResult, type Principal } from '../shared/types';
import { HttpError } from './http';
import { deleteFilePermanently, restoreFile, trashFile } from './trash';

export async function manageFiles(env: Env, user: Principal, action: BulkAction, ids: string[], confirm = false): Promise<BulkResult> {
  if (!['trash', 'restore', 'delete'].includes(action) || !Array.isArray(ids) || !ids.length || ids.length > MAX_BULK_FILES ||
    ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) || new Set(ids).size !== ids.length) {
    throw new HttpError(400, `Send from 1 to ${MAX_BULK_FILES} unique file IDs and a valid action.`);
  }
  if (action === 'delete' && confirm !== true) throw new HttpError(400, 'Confirm permanent deletion with confirm: true.');
  const results: BulkResult['results'] = new Array(ids.length);
  let next = 0;
  const run = async () => {
    while (next < ids.length) {
      const index = next++;
      const id = ids[index]!;
      try {
        if (action === 'trash') await trashFile(env, user, id);
        else if (action === 'restore') await restoreFile(env, id);
        else await deleteFilePermanently(env, id, true);
        results[index] = { id, ok: true };
      } catch (error) {
        results[index] = { id, ok: false, status: error instanceof HttpError ? error.status : 500,
          error: error instanceof HttpError ? error.message : 'The operation failed. Try again.' };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, run));
  return { results };
}
