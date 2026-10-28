import { acceptFile, fileType } from '../shared/formats';
import type { SharedFile } from '../shared/types';
import { api } from './api';

export interface LocalFile { file: File; path: string }
export interface UploadResult { files: SharedFile[]; skipped: number; failed: number; errors: string[] }

interface FileEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file(callback: (file: File) => void, error: (error: DOMException) => void): void;
  createReader(): { readEntries(callback: (entries: FileEntry[]) => void, error: (error: DOMException) => void): void };
}

async function walk(entry: FileEntry, prefix: string): Promise<LocalFile[]> {
  const path = `${prefix}${entry.name}`;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    return [{ file, path }];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const files: LocalFile[] = [];
  while (true) {
    const entries = await new Promise<FileEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!entries.length) break;
    for (const child of entries) files.push(...await walk(child, `${path}/`));
  }
  return files;
}

export async function droppedFiles(transfer: DataTransfer): Promise<LocalFile[]> {
  // Capture handles before the drop event returns. Browsers then close the data store.
  const entries = [...transfer.items].filter(item => item.kind === 'file')
    .map(item => item.webkitGetAsEntry?.() as FileEntry | null);
  if (entries.length && entries.every(Boolean)) {
    const files: LocalFile[] = [];
    for (const entry of entries) if (entry) files.push(...await walk(entry, ''));
    return files;
  }
  return selectedFiles(transfer.files);
}

export function selectedFiles(files: FileList): LocalFile[] {
  return [...files].map(file => ({ file, path: file.webkitRelativePath || file.name }));
}

function sendFile(file: LocalFile, uploadId: string, progress: (bytes: number) => void): Promise<SharedFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/uploads/${uploadId}?path=${encodeURIComponent(file.path)}`);
    xhr.setRequestHeader('Content-Type', fileType(file.path, file.file.type) ?? 'application/octet-stream');
    xhr.upload.onprogress = event => { progress(event.loaded); };
    xhr.onerror = () => { reject(new Error('The connection failed. Try this file again.')); };
    xhr.ontimeout = () => { reject(new Error('The upload timed out. Try this file again.')); };
    xhr.timeout = 120_000;
    xhr.onload = () => {
      let result: SharedFile & { error?: string };
      try { result = JSON.parse(xhr.responseText); }
      catch { reject(new Error('Reload the page to check your Access session.')); return; }
      if (xhr.status >= 200 && xhr.status < 300) { progress(file.file.size); resolve(result); }
      else reject(new Error(result.error ?? 'The upload failed.'));
    };
    xhr.send(file.file);
  });
}

export async function uploadFiles(
  input: LocalFile[], maxBytes: number, allowedTypes: string[],
  onProgress: (complete: number, total: number, bytes: number, totalBytes: number) => void,
  onReady: (file: SharedFile) => void,
): Promise<UploadResult> {
  const paths = new Set<string>();
  const result: UploadResult = { files: [], skipped: 0, failed: 0, errors: [] };
  const accepted: LocalFile[] = [];
  for (const item of input) {
    if (!acceptFile(item.path, item.file.type, allowedTypes)) { result.skipped++; continue; }
    if (item.file.size > maxBytes || paths.has(item.path.normalize('NFC'))) {
      result.failed++;
      result.errors.push(`${item.path}: ${item.file.size > maxBytes ? 'File is too large.' : 'Duplicate path.'}`);
      continue;
    }
    paths.add(item.path.normalize('NFC'));
    accepted.push(item);
  }
  if (!accepted.length) return result;
  const { uploadId } = await api<{ uploadId: string }>('/api/uploads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const totalBytes = accepted.reduce((sum, item) => sum + item.file.size, 0);
  const bytes = new Array<number>(accepted.length).fill(0);
  let next = 0;
  let complete = 0;
  const worker = async () => {
    while (next < accepted.length) {
      const index = next++;
      const item = accepted[index]!;
      try {
        const file = await sendFile(item, uploadId, value => {
          bytes[index] = value;
          onProgress(complete, accepted.length, bytes.reduce((sum, n) => sum + n, 0), totalBytes);
        });
        result.files.push(file);
        onReady(file);
      } catch (error) {
        result.failed++;
        result.errors.push(`${item.path}: ${error instanceof Error ? error.message : 'Upload failed.'}`);
      }
      complete++;
      onProgress(complete, accepted.length, bytes.reduce((sum, n) => sum + n, 0), totalBytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, accepted.length) }, worker));
  return result;
}
