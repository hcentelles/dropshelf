import type { SharedFile } from '../shared/types';

export interface FileRow {
  id: string; upload_id: string; path: string; name: string; object_key: string;
  content_type: string; size: number; uploader_email: string | null;
  uploader_label: string; source: 'web' | 'mcp'; created_at: number;
  trashed_at: number | null; trashed_by_id: string | null; trashed_by_label: string | null;
  delete_started_at: number | null;
}

export function present(row: FileRow, env: Env): SharedFile {
  const path = row.path.split('/').map(encodeURIComponent).join('/');
  const url = `${new URL(env.CONTENT_ORIGIN).origin}/f/${row.upload_id}/${path}`;
  return {
    id: row.id, uploadId: row.upload_id, path: row.path, name: row.name,
    contentType: row.content_type, size: row.size, uploaderEmail: row.uploader_email,
    uploaderLabel: row.uploader_label, source: row.source, createdAt: row.created_at,
    trashedAt: row.trashed_at, trashedBy: row.trashed_by_label, deletionPending: row.delete_started_at !== null,
    url, downloadUrl: `${url}?download=1`,
  };
}
