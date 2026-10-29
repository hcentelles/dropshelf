CREATE INDEX files_name_order ON files(name COLLATE NOCASE, id)
  WHERE status = 'ready' AND trashed_at IS NULL AND delete_started_at IS NULL;

CREATE INDEX files_trash_name_order ON files(name COLLATE NOCASE, id)
  WHERE status IN ('trashed', 'deleting');
