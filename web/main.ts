import '@fontsource-variable/inter';
import './style.css';
import { describeAllowedTypes, formatSize } from '../shared/formats';
import type { AppConfig, FilePage, SharedFile } from '../shared/types';
import { api, copy, element, initials, toast } from './api';
import { fileRow } from './file-row';
import { droppedFiles, selectedFiles, uploadFiles, type LocalFile } from './uploads';

let config: AppConfig | undefined;
let cursor: string | null = null;
let total = 0;
let loading = false;
let loaded = false;
let uploading = false;
let recentFiles: SharedFile[] = [];
const seen = new Set<string>();
const fresh = new Set<string>();
const list = element('file-list');
const fileInput = element<HTMLInputElement>('file-input');
const folderInput = element<HTMLInputElement>('folder-input');
const dropZone = element('drop-zone');
const selectFiles = element<HTMLButtonElement>('select-files');
const selectFolder = element<HTMLButtonElement>('select-folder');

function setUploadEnabled(enabled: boolean): void {
  selectFiles.disabled = !enabled;
  selectFolder.disabled = !enabled;
  dropZone.setAttribute('aria-busy', String(uploading));
}

function showNotice(message: string, error = false): void {
  element('notice').hidden = false;
  element('notice').classList.toggle('notice-error', error);
  element('notice-text').textContent = message;
  element('notice-icon').className = `ph ph-${error ? 'warning-circle' : 'check-circle'}`;
  element<HTMLButtonElement>('copy-new').hidden = true;
}

function updateCount(): void {
  element('file-count').textContent = `${total} ${total === 1 ? 'file' : 'files'}`;
  element('empty-state').hidden = total !== 0 || !loaded;
}

function addRow(file: SharedFile, prepend = false): void {
  if (seen.has(file.id)) return;
  seen.add(file.id);
  const row = fileRow(file, fresh.has(file.id));
  if (prepend) list.prepend(row); else list.append(row);
}

async function loadPage(reset = false): Promise<void> {
  if (loading || (!reset && loaded && !cursor)) return;
  loading = true;
  element('retry-list').hidden = true;
  element('load-more').hidden = true;
  element('list-status').textContent = reset ? 'Loading files…' : 'Loading older files…';
  try {
    const query = new URLSearchParams();
    if (!reset && cursor) query.set('cursor', cursor);
    const page = await api<FilePage>(`/api/files?${query}`);
    if (reset) { seen.clear(); list.replaceChildren(); }
    for (const file of page.files) addRow(file);
    cursor = page.nextCursor;
    total = page.total;
    loaded = true;
    updateCount();
    element('list-status').textContent = cursor ? '' : total ? 'You have reached the end of the shelf.' : '';
    element('load-more').hidden = !cursor;
  } catch (error) {
    element('list-status').textContent = error instanceof Error ? error.message : 'Could not load files.';
    element('retry-list').hidden = false;
    if (!loaded) element('file-count').textContent = 'Files could not be loaded';
  } finally { loading = false; }
}

async function startUpload(files: LocalFile[]): Promise<void> {
  if (!config || uploading) return;
  if (!files.length) { showNotice('No files were found in this selection.', true); return; }
  uploading = true;
  setUploadEnabled(false);
  element('notice').hidden = true;
  element('upload-progress').hidden = false;
  element('progress-text').textContent = 'Preparing files…';
  element<HTMLProgressElement>('progress').value = 0;
  recentFiles = [];
  try {
    const result = await uploadFiles(files, config.maxFileBytes, config.allowedFileTypes, (complete, count, bytes, allBytes) => {
      element('progress-text').textContent = `Uploading ${complete} of ${count} files · ${formatSize(bytes)} of ${formatSize(allBytes)}`;
      element<HTMLProgressElement>('progress').value = allBytes ? Math.round(bytes / allBytes * 100) : Math.round(complete / count * 100);
    }, file => {
      fresh.add(file.id);
      addRow(file, true);
      total++;
      loaded = true;
      updateCount();
    });
    recentFiles = result.files;
    const parts = [`${result.files.length} ${result.files.length === 1 ? 'file' : 'files'} added.`];
    if (result.skipped) parts.push(`${result.skipped} unsupported ${result.skipped === 1 ? 'file' : 'files'} skipped.`);
    if (result.failed) parts.push(`${result.failed} ${result.failed === 1 ? 'file' : 'files'} failed. ${result.errors[0] ?? ''}`);
    showNotice(parts.join(' '), result.failed > 0 || !result.files.length);
    const copyNew = element<HTMLButtonElement>('copy-new');
    copyNew.hidden = !result.files.length;
    copyNew.textContent = `Copy ${result.files.length === 1 ? 'link' : `${result.files.length} links`}`;
    await loadPage(true);
  } catch (error) { showNotice(error instanceof Error ? error.message : 'The upload failed. Try again.', true); }
  finally {
    uploading = false;
    setUploadEnabled(true);
    element('upload-progress').hidden = true;
    fileInput.value = '';
    folderInput.value = '';
  }
}

selectFiles.addEventListener('click', () => { fileInput.click(); });
selectFolder.addEventListener('click', () => { folderInput.click(); });
fileInput.addEventListener('change', () => { if (fileInput.files) void startUpload(selectedFiles(fileInput.files)); });
folderInput.addEventListener('change', () => { if (folderInput.files) void startUpload(selectedFiles(folderInput.files)); });
element('copy-new').addEventListener('click', () => { void copy(recentFiles.map(file => file.url).join('\n')); });
element('copy-mcp').addEventListener('click', () => { if (config) void copy(config.mcpUrl); });
element('dismiss-notice').addEventListener('click', () => { element('notice').hidden = true; });
element('load-more').addEventListener('click', () => { void loadPage(); });
element('retry-list').addEventListener('click', () => { void loadPage(!loaded); });

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
  if (!event.dataTransfer || uploading) return;
  const files = droppedFiles(event.dataTransfer);
  void files.then(startUpload).catch(() => { showNotice('The folder could not be read. Use Select folder to try again.', true); });
});

new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting) && loaded && cursor && !uploading) void loadPage();
}, { rootMargin: '160px' }).observe(element('scroll-sentinel'));

document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('details[open]')) {
    if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') for (const menu of document.querySelectorAll<HTMLDetailsElement>('details[open]')) menu.open = false;
});

setUploadEnabled(false);
async function boot(): Promise<void> {
  try {
    config = await api<AppConfig>('/api/config');
    document.title = config.name;
    element('brand').textContent = config.name;
    element('user-email').textContent = config.user.label;
    element('user-email').title = config.user.label;
    element('user-avatar').textContent = initials(config.user.label);
    fileInput.accept = config.allowedFileTypes.join(',');
    folderInput.accept = config.allowedFileTypes.join(',');
    element('supported-types').textContent = `${describeAllowedTypes(config.allowedFileTypes)}. Other files are skipped.`;
    element('upload-limit').textContent = `Up to ${formatSize(config.maxFileBytes)} per file. Folder paths are kept.`;
    if (config.local) element('copy-mcp').title = 'Local development uses a test identity.';
    setUploadEnabled(true);
    await loadPage(true);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : 'The app could not connect. Reload this page to sign in.', true);
    element('file-count').textContent = 'Connection required';
    element('list-status').textContent = '';
    element('upload-limit').textContent = 'Reload this page to connect.';
    toast('The app could not connect.');
  }
}
void boot();
