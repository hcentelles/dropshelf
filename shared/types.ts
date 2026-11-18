import type { RetentionPolicy } from './retention';

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
  updatedAt: number;
  version: number;
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

export interface SharedFolder extends Pick<SharedFile, 'id' | 'path' | 'name' | 'size' |
  'uploaderLabel' | 'source' | 'createdAt' | 'updatedAt' | 'trashedAt' | 'trashedBy' | 'deletionPending'> {
  kind: 'folder';
  fileCount: number;
  downloadUrl: string;
}

export type ShelfEntry = SharedFile | SharedFolder;
export function isFolder(entry: ShelfEntry): entry is SharedFolder { return 'kind' in entry && entry.kind === 'folder'; }
export interface ExpiryWindow { firstAt: number; lastAt: number }
export type ExplorerEntry = ShelfEntry & {
  expiry: ExpiryWindow | null;
  permanent: boolean;
  permanentCount: number;
};
export interface ExplorerPage { entries: ExplorerEntry[]; nextCursor: string | null; total: number }
export interface FileScope { uploadId?: string; folder?: string }
export interface ReplaceFile { id: string; version: number }
export interface UploadCheck { path: string; existing?: SharedFile; error?: string }

export type FileView = 'files' | 'trash';
export type FileSort = 'newest' | 'oldest' | 'name';

export interface FileFilters { q?: string; type?: string; author?: string }
export interface FileQuery extends FileFilters, FileScope { sort?: FileSort }
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
  appOrigin: string;
  contentOrigin: string;
  transferOrigin?: string;
  maxFileBytes: number;
  allowedFileTypes: string[];
  mcpUrl: string;
  local: boolean;
  retention: RetentionPolicy;
}
