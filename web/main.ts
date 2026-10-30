import '@fontsource-variable/inter';
import './style.css';
import { describeAllowedTypes, formatSize } from '../shared/formats';
import type { AppConfig, SharedFile, ShelfEntry } from '../shared/types';
import { api, element, icon, identityLabel, initials, toast } from './api';
import { applyFileAction, copyFileLinks } from './bulk-actions';
import { fileRow } from './file-row';
import { createFileList } from './file-list';
import { initLiveUpdates } from './live-updates';
import { replacementPrompt } from './replace-file';
import { initInteractions } from './interactions';
import { initMcpSetup, showMcpSetupError, updateMcpSetup } from './mcp-setup';
import { currentScope, currentSection, initNavigation } from './navigation';
import { initTrashView } from './trash';
import { droppedFiles, selectedFiles, uploadFiles, type LocalFile } from './uploads';

let config: AppConfig | undefined;
let uploading = false;
let managing = false;
let recentFiles: SharedFile[] = [];
const fresh = new Set<string>();
const fileInput = element<HTMLInputElement>('file-input');
const folderInput = element<HTMLInputElement>('folder-input');
const dropZone = element('drop-zone');
const selectFiles = element<HTMLButtonElement>('select-files');
const selectFolder = element<HTMLButtonElement>('select-folder');
const activeFiles = createFileList({
  prefix: '', view: 'files', canAutoLoad: () => !uploading,
  render: file => fileRow(file, fresh.has(file.id), { trash: moveToTrash }),
  onState: state => { managing = state.busy; setUploadEnabled(!!config && !uploading && !managing); },
});
const trash = initTrashView(() => {
  activeFiles.invalidate();
  if (currentSection() === 'files') void activeFiles.ensureFresh();
});

function setUploadEnabled(enabled: boolean): void {
  selectFiles.disabled = !enabled;
  selectFolder.disabled = !enabled;
  dropZone.setAttribute('aria-busy', String(uploading));
}

function updateUploadDestination(): void {
  if (!config) return;
  const folder = currentScope().folder;
  element('upload-limit').textContent = `Up to ${formatSize(config.maxFileBytes)} per file. ${folder ? `Upload to /${folder}.` : 'Folder paths are kept.'}`;
}

function showNotice(message: string, error = false): void {
  element('notice').hidden = false;
  element('notice').classList.toggle('notice-error', error);
  element('notice-text').textContent = message;
  element('notice-icon').className = `ph ph-${error ? 'warning-circle' : 'check-circle'}`;
  element<HTMLButtonElement>('copy-new').hidden = true;
}

function updateRecentCopy(): void {
  const copyNew = element<HTMLButtonElement>('copy-new');
  copyNew.hidden = !recentFiles.length;
  copyNew.replaceChildren(icon('copy'), document.createTextNode(`Copy ${recentFiles.length === 1 ? 'link' : `${recentFiles.length} links`}`));
}

async function moveToTrash(file: ShelfEntry): Promise<void> {
  await trashEntries([file]);
}

async function startUpload(files: LocalFile[], folder = currentScope().folder): Promise<void> {
  if (!config || uploading || managing) return;
  if (!files.length) { showNotice('No files were found in this selection.', true); return; }
  const incoming = files.map(item => ({ ...item, path: folder ? `${folder}/${item.path}` : item.path }));
  uploading = true;
  setUploadEnabled(false);
  element('notice').hidden = true;
  element('upload-progress').hidden = false;
  element('progress-text').textContent = 'Preparing files…';
  element<HTMLProgressElement>('progress').value = 0;
  recentFiles = [];
  try {
    const result = await uploadFiles(incoming, config.maxFileBytes, config.allowedFileTypes, (complete, count, bytes, allBytes) => {
      element('progress-text').textContent = `Uploading ${complete} of ${count} files · ${formatSize(bytes)} of ${formatSize(allBytes)}`;
      element<HTMLProgressElement>('progress').value = allBytes ? Math.round(bytes / allBytes * 100) : Math.round(complete / count * 100);
    }, file => {
      fresh.add(file.id);
      activeFiles.insert(file);
    }, replacementPrompt());
    recentFiles = result.files;
    const added = result.files.length - result.replaced;
    const parts = [`${added} ${added === 1 ? 'file' : 'files'} added.`];
    if (result.replaced) parts.push(`${result.replaced} ${result.replaced === 1 ? 'file' : 'files'} replaced.`);
    if (result.skippedExisting) parts.push(`${result.skippedExisting} existing ${result.skippedExisting === 1 ? 'file' : 'files'} skipped.`);
    if (result.cancelled) parts.push('Upload cancelled.');
    if (result.skipped) parts.push(`${result.skipped} unsupported ${result.skipped === 1 ? 'file' : 'files'} skipped.`);
    if (result.failed) parts.push(`${result.failed} ${result.failed === 1 ? 'file' : 'files'} failed. ${result.errors[0] ?? ''}`);
    showNotice(parts.join(' '), result.failed > 0);
    updateRecentCopy();
    await activeFiles.refresh();
  } catch (error) { showNotice(error instanceof Error ? error.message : 'The upload failed. Try again.', true); }
  finally {
    uploading = false;
    setUploadEnabled(true);
    element('upload-progress').hidden = true;
    fileInput.value = '';
    folderInput.value = '';
    activeFiles.requestLiveUpdate();
  }
}

selectFiles.addEventListener('click', () => { fileInput.click(); });
selectFolder.addEventListener('click', () => { folderInput.click(); });
fileInput.addEventListener('change', () => { if (fileInput.files) void startUpload(selectedFiles(fileInput.files)); });
folderInput.addEventListener('change', () => { if (folderInput.files) void startUpload(selectedFiles(folderInput.files)); });
element('copy-new').addEventListener('click', () => { void copyFileLinks(recentFiles); });
element('bulk-copy').addEventListener('click', () => { void copyFileLinks(activeFiles.selected()); });
element('bulk-trash').addEventListener('click', () => { void trashEntries(activeFiles.selected()); });
async function trashEntries(entries: ShelfEntry[]): Promise<void> {
  const files = await activeFiles.resolveEntries(entries);
  if (!files.length) return;
  const result = await applyFileAction(activeFiles, 'trash', files, () => { trash.invalidate(); });
  const failed = new Set(result.failed.map(item => item.id));
  const moved = new Set(files.filter(file => !failed.has(file.id)).map(file => file.id));
  recentFiles = recentFiles.filter(file => !moved.has(file.id));
  for (const id of moved) fresh.delete(id);
  updateRecentCopy();
}
element('dismiss-notice').addEventListener('click', () => { element('notice').hidden = true; });

let dragDepth = 0;
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => { event.preventDefault(); });
dropZone.addEventListener('dragenter', event => {
  event.preventDefault();
  dragDepth++;
  if (!uploading) dropZone.classList.add('drag-active');
});
dropZone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove('drag-active'); } });
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove('drag-active');
  if (!event.dataTransfer || uploading || managing) return;
  const folder = currentScope().folder;
  const files = droppedFiles(event.dataTransfer);
  void files.then(items => startUpload(items, folder)).catch(() => { showNotice('The folder could not be read. Use Select folder to try again.', true); });
});

initInteractions();
initMcpSetup();
initNavigation(section => {
  if (section !== 'trash') trash.leave();
  if (section !== 'files') activeFiles.clearSelection();
  const scope = currentScope();
  if (section === 'files') { activeFiles.setScope(scope); updateUploadDestination(); }
  if (section === 'trash') trash.setScope(scope);
  if (!config) return;
  if (section === 'files') void activeFiles.ensureFresh();
  if (section === 'trash') void trash.ensureFresh();
});
setUploadEnabled(false);
async function boot(): Promise<void> {
  try {
    config = await api<AppConfig>('/api/config');
    document.title = config.name;
    element('brand').textContent = config.name;
    element('user-email').textContent = identityLabel(config.user.label);
    element('user-email').title = identityLabel(config.user.label);
    element('user-avatar').textContent = initials(config.user.label);
    fileInput.accept = config.allowedFileTypes.join(',');
    folderInput.accept = config.allowedFileTypes.join(',');
    element('supported-types').textContent = `${describeAllowedTypes(config.allowedFileTypes)}. Other files are skipped.`;
    updateUploadDestination();
    const { fileDays, trashDays } = config.retention;
    const period = (days: number) => `${days} ${days === 1 ? 'day' : 'days'}`;
    element('retention-note').hidden = !fileDays;
    element('retention-note').textContent = `Files and folders move to Trash ${period(fileDays)} after their last upload, replacement, or restore.`;
    element('trash-retention-note').textContent = (trashDays
      ? `Files are deleted permanently after ${period(trashDays)} in Trash. `
      : 'Automatic deletion is off. ') + 'Shared links are inactive while files are in Trash.';
    updateMcpSetup(config);
    setUploadEnabled(true);
    initLiveUpdates(() => { activeFiles.requestLiveUpdate(); trash.requestLiveUpdate(); });
    if (currentSection() === 'trash') await trash.ensureFresh();
    else if (currentSection() === 'files') await activeFiles.ensureFresh();
  } catch (error) {
    showMcpSetupError(error instanceof Error ? error.message : 'The app could not connect. Reload this page to sign in.');
    activeFiles.fail(error instanceof Error ? error.message : 'Reload this page to connect.');
    trash.fail(error instanceof Error ? error.message : 'Reload this page to connect.');
    showNotice(error instanceof Error ? error.message : 'The app could not connect. Reload this page to sign in.', true);
    element('file-count').textContent = 'Connection required';
    element('list-status').textContent = '';
    element('upload-limit').textContent = 'Reload this page to connect.';
    toast('The app could not connect.');
  }
}
void boot();
