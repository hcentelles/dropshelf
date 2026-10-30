
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

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
INSERT INTO schema_migrations (version) VALUES (1);
