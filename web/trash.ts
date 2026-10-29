import type { SharedFile, ShelfEntry } from '../shared/types';
import { element, icon, toast } from './api';
import { applyFileAction } from './bulk-actions';
import { createFileList } from './file-list';
import { fileRow } from './file-row';
import { collectFiles } from './file-search';

export function initTrashView(onChange: () => void) {
  const dialog = element<HTMLDialogElement>('delete-file-dialog');
  const confirm = element<HTMLButtonElement>('confirm-delete-file');
  const cancel = element<HTMLButtonElement>('cancel-delete-file');
  const deleteAll = element<HTMLButtonElement>('trash-delete-all');
  const errorBox = element('delete-file-error');
  let targets: SharedFile[] = [];
  let deleting = false;
  let preparing: AbortController | undefined;
  let allTotal = 0;
  let listBusy = false;

  const list = createFileList({
    prefix: 'trash-', view: 'trash',
    render: file => fileRow(file, false, { restore: file => restore([file]), deletePermanently: file => { void prepareDelete([file]); } }),
    onState: state => {
      allTotal = state.total;
      listBusy = state.busy;
      deleteAll.hidden = state.inFolder;
      deleteAll.disabled = !allTotal || listBusy || deleting;
    },
  });

  function label(text: string): void {
    confirm.replaceChildren(icon('trash'), document.createTextNode(text));
  }

  async function restore(entries: ShelfEntry[]): Promise<void> {
    const files = await list.resolveEntries(entries);
    if (files.length) await applyFileAction(list, 'restore', files, onChange);
  }

  async function prepareDelete(entries: ShelfEntry[]): Promise<void> {
    const files = await list.resolveEntries(entries);
    if (files.length) showDelete(files);
  }

  function showDelete(files: SharedFile[], all = false): void {
    if (!files.length || deleting) return;
    targets = [...files];
    const count = files.length;
    element('delete-file-heading').textContent = count === 1 ? 'Delete this file permanently?' : `Delete ${count} files permanently?`;
    element('delete-file-name').textContent = files.slice(0, 3).map(file => file.name).join(', ') + (count > 3 ? `, and ${count - 3} more` : '');
    element('delete-file-meta').textContent = all
      ? `All ${count} files in Trash are included. This includes files hidden by search or filters. Files added later are not included.`
      : `${count} selected ${count === 1 ? 'file' : 'files'} in Trash.`;
    errorBox.hidden = true;
    label(files.some(file => file.deletionPending) ? 'Retry permanent delete' : 'Delete permanently');
    dialog.showModal();
  }

  async function prepareDeleteAll(): Promise<void> {
    if (preparing || deleting || listBusy) return;
    const controller = new AbortController();
    preparing = controller;
    list.setBusy(true, 'Counting all files in Trash…');
    try {
      const files = await collectFiles('trash', {}, controller.signal);
      if (!controller.signal.aborted) {
        if (files.length) showDelete(files, true);
        else { toast('Trash is empty.'); list.invalidate(); await list.refresh(); }
      }
    } catch (error) {
      if (!controller.signal.aborted) toast(error instanceof Error ? error.message : 'Trash could not be loaded. Try again.');
    } finally {
      if (preparing === controller) preparing = undefined;
      list.setBusy(false);
    }
  }

  element('trash-bulk-restore').addEventListener('click', () => { void restore(list.selected()); });
  element('trash-bulk-delete').addEventListener('click', () => { void prepareDelete(list.selected()); });
  deleteAll.addEventListener('click', () => { void prepareDeleteAll(); });
  cancel.addEventListener('click', () => { dialog.close(); });
  dialog.addEventListener('close', () => { targets = []; });
  dialog.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
  confirm.addEventListener('click', () => { void permanentlyDelete(); });

  async function permanentlyDelete(): Promise<void> {
    const files = [...targets];
    if (!files.length || deleting) return;
    deleting = true;
    confirm.disabled = true;
    cancel.disabled = true;
    deleteAll.disabled = true;
    label('Deleting…');
    errorBox.hidden = true;
    try {
      const result = await applyFileAction(list, 'delete', files, onChange);
      if (!result.failed.length) dialog.close();
      else {
        const failedIds = new Set(result.failed.map(item => item.id));
        targets = files.filter(file => failedIds.has(file.id));
        errorBox.textContent = `${result.message} Retry will process only the files that failed.`;
        errorBox.hidden = false;
        element('delete-file-heading').textContent = `Retry deletion of ${targets.length} ${targets.length === 1 ? 'file' : 'files'}?`;
        element('delete-file-name').textContent = targets.slice(0, 3).map(file => file.name).join(', ');
        element('delete-file-meta').textContent = `${targets.length} files remain. Successfully deleted files are excluded.`;
      }
    } finally {
      deleting = false;
      confirm.disabled = false;
      cancel.disabled = false;
      deleteAll.disabled = !allTotal || listBusy;
      label('Retry permanent delete');
    }
  }

  return {
    ...list,
    leave: () => {
      preparing?.abort();
      if (dialog.open) dialog.close();
      list.clearSelection();
    },
  };
}
