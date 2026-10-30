import { retentionPolicy } from '../shared/retention';
import { shelf } from './shelf-client';

export async function runRetention(env: Env): Promise<{ trashed: number; deleted: number; failed: number }> {
  // Validate both values before any mutation. The object uses its own settings
  // for eligibility; callers cannot choose a different expiry date.
  retentionPolicy(env);
  const store = shelf(env);
  const trashed = await store.expireFiles();
  const pending = await store.beginExpiredDeletion();
  let deleted = 0;
  let failed = 0;
  for (const file of pending) {
    try {
      await env.FILES.delete(file.object_key);
      await store.finishDelete(file.id);
      deleted++;
    } catch (error) {
      failed++;
      console.error(JSON.stringify({ event: 'retention_delete_failed', fileId: file.id,
        message: error instanceof Error ? error.message : 'Unknown error' }));
    }
  }
  // Pending records keep restore blocked. The next scheduled run retries them,
  // even if automatic deletion has since been disabled.
  return { trashed, deleted, failed };
}
