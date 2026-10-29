CREATE TABLE files_with_trash (
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

INSERT INTO files_with_trash
  (id, upload_id, path, name, object_key, content_type, size, uploader_id,
    uploader_email, uploader_label, source, status, created_at)
SELECT id, upload_id, path, name, object_key, content_type, size, uploader_id,
  uploader_email, uploader_label, source, status, created_at FROM files;

DROP TABLE files;
ALTER TABLE files_with_trash RENAME TO files;

CREATE INDEX files_history ON files(status, created_at DESC, id DESC);
CREATE INDEX files_trash_history ON files(trashed_at DESC, id DESC)
  WHERE status IN ('trashed', 'deleting');

CREATE TABLE deleted_files (
  id TEXT PRIMARY KEY,
  object_key_hash TEXT NOT NULL UNIQUE
);
