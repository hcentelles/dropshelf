import type { Principal, SharedFile } from '../shared/types';
import { shelf } from './shelf-client';

export async function trashFile(env: Env, user: Principal, id: string): Promise<SharedFile> {
  return shelf(env).trashFile(user, id);
}

export async function restoreFile(env: Env, id: string): Promise<SharedFile> { return shelf(env).restoreFile(id); }

export async function deleteFilePermanently(env: Env, id: string, confirmed: boolean): Promise<{ id: string; deleted: true }> {
  const store = shelf(env);
  // Persist the deleting state before removing R2 bytes. Restore stays blocked
  // if either R2 deletion or the final metadata transaction fails.
  const key = await store.beginDelete(id, confirmed);
  if (key) {
    await env.FILES.delete(key);
    await store.finishDelete(id);
  }
  return { id, deleted: true };
}
