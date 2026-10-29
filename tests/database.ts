import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { shelf } from '../worker/shelf-client';

export function database<T>(callback: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(shelf(env), (_instance, state) => callback(state.storage.sql));
}

export async function prepareDatabase(): Promise<void> {
  await database(sql => { sql.exec('SELECT version FROM schema_migrations').toArray(); });
}

export async function resetDatabase(): Promise<void> {
  await database(sql => { sql.exec('DELETE FROM files; DELETE FROM uploads; DELETE FROM deleted_files;'); });
}
