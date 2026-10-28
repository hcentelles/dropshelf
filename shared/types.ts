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
  url: string;
  downloadUrl: string;
}

export interface FilePage {
  files: SharedFile[];
  nextCursor: string | null;
  total: number;
}

export interface AppConfig {
  name: string;
  user: Principal;
  maxFileBytes: number;
  allowedFileTypes: string[];
  mcpUrl: string;
  local: boolean;
}
