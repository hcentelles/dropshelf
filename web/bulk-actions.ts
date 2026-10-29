import { MAX_BULK_FILES, type BulkAction, type BulkResult, type SharedFile, type ShelfEntry } from '../shared/types';
import { api, copy, element, toast } from './api';
import type { FileListController } from './file-list';
import { entryUrl } from './navigation';

export async function copyFileLinks(files: ShelfEntry[]): Promise<void> {
  if (!files.length) return;
  const links = files.map(file => entryUrl(file)).join('\n');
  if (await copy(links, `${files.length} ${files.length === 1 ? 'link' : 'links'} copied.`, 'Copy failed. Copy the links from the text box.')) return;
  const field = element<HTMLTextAreaElement>('copy-links-text');
  field.value = links;
  const dialog = element<HTMLDialogElement>('copy-links-dialog');
  dialog.showModal();
  field.focus();
  field.select();
}

export async function applyFileAction(list: FileListController, action: BulkAction, files: SharedFile[], onChange: () => void) {
  const results: BulkResult['results'] = [];
  list.setBusy(true, `Processing 0 of ${files.length} files…`);
  try {
    for (let offset = 0; offset < files.length; offset += MAX_BULK_FILES) {
      const chunk = files.slice(offset, offset + MAX_BULK_FILES);
      try {
        const result = await api<BulkResult>('/api/files/bulk', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ids: chunk.map(file => file.id), ...(action === 'delete' ? { confirm: true } : {}) }),
        });
        results.push(...result.results);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The connection failed. Try again.';
        results.push(...files.slice(offset).map(file => ({ id: file.id, ok: false, error: message })));
        break;
      }
      list.setBusy(true, `Processed ${Math.min(offset + MAX_BULK_FILES, files.length)} of ${files.length} files…`);
    }
  } finally {
    list.clearSelection();
    list.invalidate();
    await list.refresh();
    list.setBusy(false);
    onChange();
  }
  const failed = results.filter(result => !result.ok);
  const count = results.length - failed.length;
  const verb = action === 'trash' ? 'moved to Trash' : action === 'restore' ? 'restored' : 'deleted permanently';
  const message = `${count} ${count === 1 ? 'file' : 'files'} ${verb}.${failed.length ? ` ${failed.length} failed. ${failed[0]!.error ?? ''}` : ''}`;
  toast(message);
  return { failed, message };
}
