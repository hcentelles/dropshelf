export interface Principal {
  id: string;
  email: string | null;
  label: string;
  kind: 'user' | 'service';
}

export interface SharedFile {
  id: string;
  uploadId: string;
  path: string;
  name: string;
  contentType: string;
  size: number;
  uploaderEmail: string | null;
  uploaderLabel: string;
  source: 'web' | 'mcp';
  createdAt: number;
  trashedAt: number | null;
  trashedBy: string | null;
  deletionPending: boolean;
  url: string;
  downloadUrl: string;
}

export interface FilePage {
  files: SharedFile[];
  nextCursor: string | null;
  total: number;
}

export type FileView = 'files' | 'trash';
export type FileSort = 'newest' | 'oldest' | 'name';

export interface FileFilters { q?: string; type?: string; author?: string }
export interface FileQuery extends FileFilters { sort?: FileSort }
export interface FileFilterOptions {
  total: number;
  types: Array<{ value: string; label: string; count: number }>;
  authors: Array<{ value: string; label: string; count: number }>;
}
export type BulkAction = 'trash' | 'restore' | 'delete';
export interface BulkResult {
  results: Array<{ id: string; ok: boolean; error?: string; status?: number }>;
}
export const MAX_BULK_FILES = 10;

export interface AppConfig {
  name: string;
  user: Principal;
  maxFileBytes: number;
  allowedFileTypes: string[];
  mcpUrl: string;
  local: boolean;
}
