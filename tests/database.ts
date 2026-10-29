import { env } from 'cloudflare:workers';
import files from '../migrations/0001_files.sql?raw';
import trash from '../migrations/0002_trash.sql?raw';

export async function prepareDatabase(): Promise<void> {
  for (const migration of [files, trash]) {
    await env.DB.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => env.DB.prepare(sql)));
  }
}
