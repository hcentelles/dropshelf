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
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready')),
  created_at INTEGER NOT NULL,
  UNIQUE (upload_id, path)
);

CREATE INDEX files_history ON files(status, created_at DESC, id DESC);
CREATE INDEX uploads_owner ON uploads(owner_id, created_at);
