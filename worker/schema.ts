const schema = `
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL REFERENCES uploads(id),
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  uploader_id TEXT NOT NULL,
  uploader_email TEXT,
  uploader_label TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'mcp')),
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'trashed', 'deleting')),
  created_at INTEGER NOT NULL,
  trashed_at INTEGER,
  trashed_by_id TEXT,
  trashed_by_label TEXT,
  delete_started_at INTEGER,
  UNIQUE (upload_id, path),
  CHECK (
    (status IN ('uploading', 'ready') AND trashed_at IS NULL AND delete_started_at IS NULL)
    OR (status = 'trashed' AND trashed_at IS NOT NULL AND delete_started_at IS NULL)
    OR (status = 'deleting' AND trashed_at IS NOT NULL AND delete_started_at IS NOT NULL)
  )
);
CREATE INDEX files_history ON files(status, created_at DESC, id DESC);
CREATE INDEX files_trash_history ON files(trashed_at DESC, id DESC) WHERE status IN ('trashed', 'deleting');
CREATE INDEX files_name_order ON files(name COLLATE NOCASE, id)
  WHERE status = 'ready' AND trashed_at IS NULL AND delete_started_at IS NULL;
CREATE INDEX files_trash_name_order ON files(name COLLATE NOCASE, id) WHERE status IN ('trashed', 'deleting');
CREATE INDEX uploads_owner ON uploads(owner_id, created_at);
CREATE TABLE deleted_files (id TEXT PRIMARY KEY, object_key_hash TEXT NOT NULL UNIQUE);
`;

export function initializeSchema(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
  const version = sql.exec<{ version: number }>('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').one().version;
  if (version === 0) {
    storage.transactionSync(() => {
      sql.exec(schema);
      sql.exec('INSERT INTO schema_migrations (version) VALUES (1)');
    });
  }
  if (version < 2) {
    storage.transactionSync(() => {
      sql.exec(`
        ALTER TABLE files ADD COLUMN url_path TEXT;
        ALTER TABLE files ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE files ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
        UPDATE files SET url_path = path, updated_at = created_at;
        CREATE TABLE file_links (
          upload_id TEXT NOT NULL, path TEXT NOT NULL, file_id TEXT NOT NULL,
          PRIMARY KEY (upload_id, path)
        );
        INSERT INTO file_links SELECT upload_id, path, id FROM files;
        CREATE TABLE upload_writes (
          id TEXT PRIMARY KEY, upload_id TEXT NOT NULL, path TEXT NOT NULL, file_id TEXT NOT NULL,
          expected_version INTEGER, object_key TEXT NOT NULL UNIQUE,
          content_type TEXT NOT NULL, size INTEGER NOT NULL,
          uploader_id TEXT NOT NULL, uploader_email TEXT, uploader_label TEXT NOT NULL,
          source TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('uploading', 'complete'))
        );
        CREATE UNIQUE INDEX upload_writes_path ON upload_writes(path) WHERE state = 'uploading';
        CREATE TABLE retired_objects (object_key TEXT PRIMARY KEY, delete_after INTEGER NOT NULL);
      `);
      // Keep all old links and bytes. Only rename legacy file conflicts; folders merge.
      const rows = sql.exec<{ id: string; path: string }>("SELECT id, path FROM files WHERE status IN ('ready', 'uploading') ORDER BY created_at, id").toArray();
      // Trash can still reserve a name inside an old upload group.
      const reserved = new Set(sql.exec<{ path: string }>('SELECT path FROM files').toArray().map(row => row.path));
      const assigned = new Set<string>();
      for (const row of rows) {
        let path = row.path;
        if (assigned.has(path) || rows.some(other => other.path.startsWith(`${path}/`))) {
          const slash = path.lastIndexOf('/');
          const directory = path.slice(0, slash + 1);
          const name = path.slice(slash + 1);
          const dot = name.lastIndexOf('.');
          const extension = dot > 0 ? name.slice(dot).slice(0, 40) : '';
          const stem = dot > 0 ? name.slice(0, dot) : name;
          let number = 2;
          do {
            const suffix = ` (copy ${number++})${extension}`;
            path = `${directory}${stem.slice(0, 255 - suffix.length)}${suffix}`;
            if (path.length > 1024) path = `Recovered files/${row.id}/${number}/${name}`;
          } while (reserved.has(path) || rows.some(other => other.path.startsWith(`${path}/`)));
          sql.exec('UPDATE files SET path = ?, name = ? WHERE id = ?', path, path.split('/').at(-1)!, row.id);
          reserved.add(path);
        }
        assigned.add(path);
      }
      sql.exec(`
        CREATE UNIQUE INDEX files_active_path ON files(path) WHERE status IN ('ready', 'uploading');
        INSERT INTO schema_migrations (version) VALUES (2);
      `);
    });
  }
  if (version < 3) {
    storage.transactionSync(() => {
      sql.exec(`
        ALTER TABLE files ADD COLUMN restored_at INTEGER;
        INSERT INTO schema_migrations (version) VALUES (3);
      `);
    });
  }
  if (version < 4) {
    storage.transactionSync(() => {
      sql.exec(`
        CREATE TABLE retention_settings (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
          mode TEXT NOT NULL CHECK (mode IN ('30-days', 'permanent')),
          changed_at INTEGER NOT NULL
        );
        CREATE INDEX retention_settings_path ON retention_settings(kind, path);
        INSERT INTO schema_migrations (version) VALUES (4);
      `);
    });
  }
  if (version < 5) {
    storage.transactionSync(() => {
      sql.exec(`
        CREATE TABLE transfer_grants (
          id TEXT PRIMARY KEY,
          method TEXT NOT NULL CHECK (method IN ('GET', 'PUT')),
          grant_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX transfer_grants_expiry ON transfer_grants(expires_at);
        INSERT INTO schema_migrations (version) VALUES (5);
      `);
    });
  }
  if (version < 6) {
    storage.transactionSync(() => {
      sql.exec(`
        ALTER TABLE transfer_grants RENAME TO single_file_grants;
        CREATE TABLE transfer_grants (
          id TEXT PRIMARY KEY,
          method TEXT NOT NULL CHECK (method IN ('GET', 'PUT', 'POST')),
          grant_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        INSERT INTO transfer_grants SELECT id, method, grant_json, expires_at FROM single_file_grants;
        DROP TABLE single_file_grants;
        CREATE INDEX transfer_grants_expiry ON transfer_grants(expires_at);
        INSERT INTO schema_migrations (version) VALUES (6);
      `);
    });
  }
}
