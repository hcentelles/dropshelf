import { acceptFile, fileType } from '../shared/formats';
import type { ReplaceFile, SharedFile, UploadCheck } from '../shared/types';
import { api, ApiError } from './api';
import type { ConfirmReplacement } from './replace-file';

export interface LocalFile { file: File; path: string }
export interface UploadResult { files: SharedFile[]; replaced: number; skipped: number; skippedExisting: number; failed: number; errors: string[]; cancelled: boolean }

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

function sendFile(file: LocalFile, uploadId: string, progress: (bytes: number) => void, replace?: ReplaceFile): Promise<SharedFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ path: file.path });
    if (replace) { query.set('replaceId', replace.id); query.set('replaceVersion', String(replace.version)); }
    xhr.open('PUT', `/api/uploads/${uploadId}?${query}`);
    xhr.setRequestHeader('Content-Type', fileType(file.path, file.file.type) ?? 'application/octet-stream');
    xhr.upload.onprogress = event => { progress(event.loaded); };
    xhr.onerror = () => { reject(new Error('The connection failed. Try this file again.')); };
    xhr.ontimeout = () => { reject(new Error('The upload timed out. Try this file again.')); };
    xhr.timeout = 120_000;
    xhr.onload = () => {
      let result: SharedFile & { error?: string; conflict?: SharedFile };
      try { result = JSON.parse(xhr.responseText); }
      catch { reject(new Error('Reload the page to check your Access session.')); return; }
      if (xhr.status >= 200 && xhr.status < 300) { progress(file.file.size); resolve(result); }
      else reject(new ApiError(result.error ?? 'The upload failed.', xhr.status, result.conflict));
    };
    xhr.send(file.file);
  });
}

export async function uploadFiles(
  input: LocalFile[], maxBytes: number, allowedTypes: string[],
  onProgress: (complete: number, total: number, bytes: number, totalBytes: number) => void,
  onReady: (file: SharedFile) => void,
  confirm: ConfirmReplacement,
): Promise<UploadResult> {
  const paths = new Set<string>();
  const result: UploadResult = { files: [], replaced: 0, skipped: 0, skippedExisting: 0, failed: 0, errors: [], cancelled: false };
  const accepted: LocalFile[] = [];
  for (const raw of input) {
    const item = { ...raw, path: raw.path.normalize('NFC') };
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
  const checked: UploadCheck[] = [];
  for (let offset = 0; offset < accepted.length; offset += 100) {
    checked.push(...await api<UploadCheck[]>('/api/uploads/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: accepted.slice(offset, offset + 100).map(item => item.path) }),
    }));
  }
  const approved: Array<{ item: LocalFile; replace?: ReplaceFile }> = [];
  for (const [index, item] of accepted.entries()) {
    const check = checked[index]!;
    if (check.error) { result.failed++; result.errors.push(`${item.path}: ${check.error}`); continue; }
    if (check.existing) {
      const choice = await confirm(item, check.existing, false);
      if (choice === 'cancel') { result.cancelled = true; return result; }
      if (choice === 'skip') { result.skippedExisting++; continue; }
      approved.push({ item, replace: { id: check.existing.id, version: check.existing.version } });
    } else approved.push({ item });
  }
  if (!approved.length) return result;
  const { uploadId } = await api<{ uploadId: string }>('/api/uploads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const totalBytes = approved.reduce((sum, entry) => sum + entry.item.file.size, 0);
  const bytes = Array.from({ length: approved.length }, () => 0);
  let next = 0;
  let complete = 0;
  const progress = () => { onProgress(complete, approved.length, bytes.reduce((sum, n) => sum + n, 0), totalBytes); };
  const worker = async () => {
    while (next < approved.length && !result.cancelled) {
      const index = next++;
      const entry = approved[index]!;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const file = await sendFile(entry.item, uploadId, value => { bytes[index] = value; progress(); }, entry.replace);
          result.files.push(file);
          if (entry.replace) result.replaced++;
          onReady(file);
          break;
        } catch (error) {
          if (error instanceof ApiError && error.status === 409 && error.conflict && attempt < 2) {
            const choice = await confirm(entry.item, error.conflict, true);
            if (choice === 'cancel') { result.cancelled = true; break; }
            if (choice === 'skip') { result.skippedExisting++; break; }
            entry.replace = { id: error.conflict.id, version: error.conflict.version };
            bytes[index] = 0;
          } else {
            result.failed++;
            result.errors.push(`${entry.item.path}: ${error instanceof Error ? error.message : 'Upload failed.'}`);
            break;
          }
        }
      }
      complete++;
      progress();
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, approved.length) }, worker));
  return result;
}
