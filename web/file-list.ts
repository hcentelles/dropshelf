import type { FilePage, FileView, SharedFile } from '../shared/types';
import { api, element, icon, toast } from './api';
import { collectFiles, fileQuery, initFileSearch } from './file-search';

interface FileListOptions {
  prefix: string;
  view: FileView;
  render: (file: SharedFile) => HTMLTableRowElement;
  canAutoLoad?: () => boolean;
  onState?: (state: { total: number; busy: boolean }) => void;
}

export function createFileList(options: FileListOptions) {
  const number = new Intl.NumberFormat('en');
  const node = (name: string) => element(`${options.prefix}${name}`);
  const rows = node('file-list');
  const header = node('select-all') as HTMLInputElement;
  const toolbar = node('bulk-toolbar');
  const matching = node('select-matching') as HTMLButtonElement;
  const records = new Map<string, SharedFile>();
  const selection = new Map<string, SharedFile>();
  let cursor: string | null = null;
  let total = 0;
  let loaded = false;
  let stale = false;
  let retryReset = true;
  let revision = 0;
  let pending = false;
  let busy = false;
  let busyText = '';
  let request: AbortController | undefined;
  let collecting: AbortController | undefined;
  const search = initFileSearch(options.prefix, options.view, fetch => {
    revision++;
    request?.abort();
    request = undefined;
    clearSelection();
    pending = true;
    sync();
    if (fetch) void load(true);
  }, () => { sync(); });

  function sync(): void {
    const locked = busy || pending || !!collecting;
    rows.inert = locked;
    rows.setAttribute('aria-busy', String(locked));
    search.lock(busy || !!collecting);
    header.disabled = locked || !records.size;
    const checked = [...records.keys()].filter(id => selection.has(id)).length;
    header.checked = records.size > 0 && checked === records.size;
    header.indeterminate = checked > 0 && checked < records.size;
    toolbar.hidden = !selection.size && !busy && !collecting;
    node('selection-count').textContent = collecting ? 'Selecting all matching files…' : busy ? busyText : `${number.format(selection.size)} selected`;
    matching.hidden = !selection.size || selection.size >= total || busy;
    matching.replaceChildren(icon('checks'), document.createTextNode(`Select all ${number.format(total)}`));
    matching.setAttribute('aria-label', `Select all ${number.format(total)} matching files`);
    for (const button of toolbar.querySelectorAll('button')) button.disabled = locked;
    for (const row of rows.querySelectorAll<HTMLTableRowElement>('tr')) {
      const selected = selection.has(row.dataset.fileId!);
      row.classList.toggle('is-selected', selected);
      row.querySelector<HTMLInputElement>('.file-select')!.checked = selected;
    }
    node('load-more').toggleAttribute('disabled', locked);
    options.onState?.({ total: search.total, busy: busy || !!collecting });
  }

  function clearSelection(): void {
    collecting?.abort();
    collecting = undefined;
    selection.clear();
    sync();
  }

  function updateCount(): void {
    node('file-count').textContent = `${number.format(total)} ${total === 1 ? 'file' : 'files'}${search.active() ? ' found' : ''}`;
    node('empty-state').hidden = total !== 0 || !loaded || search.active();
    node('no-results').hidden = total !== 0 || !loaded || !search.active();
    if (loaded && !cursor) node('list-status').textContent = total
      ? `You have reached the end of ${options.view === 'trash' ? 'Trash' : 'the shelf'}.` : '';
    sync();
  }

  function append(file: SharedFile, prepend = false): void {
    if (records.has(file.id)) return;
    records.set(file.id, file);
    const row = options.render(file);
    const cell = document.createElement('td');
    cell.setAttribute('role', 'cell');
    cell.className = 'col-select';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'file-select';
    checkbox.setAttribute('aria-label', `Select ${file.name}`);
    checkbox.checked = selection.has(file.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selection.set(file.id, file); else selection.delete(file.id);
      sync();
    });
    const target = document.createElement('label');
    target.className = 'selection-target';
    target.append(checkbox);
    cell.append(target);
    row.prepend(cell);
    if (prepend) rows.prepend(row); else rows.append(row);
  }

  function fail(message: string): void {
    node('list-status').textContent = message;
    node('retry-list').hidden = false;
    if (!loaded) node('file-count').textContent = 'Files could not be loaded';
  }

  async function load(reset = false): Promise<void> {
    if (!reset && (request || busy || pending || (loaded && !cursor))) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const started = revision;
    if (reset) pending = true;
    node('retry-list').hidden = true;
    node('load-more').hidden = true;
    node('list-status').textContent = reset ? 'Loading files…' : 'Loading more files…';
    sync();
    void search.refresh();
    try {
      const page = await api<FilePage>(fileQuery(options.view, search.values(), reset ? null : cursor), { signal: controller.signal });
      if (controller.signal.aborted || started !== revision) return;
      if (reset) { records.clear(); rows.replaceChildren(); }
      for (const file of page.files) append(file);
      cursor = page.nextCursor;
      total = page.total;
      loaded = true;
      stale = false;
      pending = false;
      updateCount();
      if (cursor) node('list-status').textContent = '';
      node('load-more').hidden = !cursor;
    } catch (error) {
      if (controller.signal.aborted || started !== revision) return;
      retryReset = reset || !loaded;
      fail(error instanceof Error ? error.message : 'Could not load files.');
      // Keep old rows inactive after a failed search or sort change.
    } finally {
      if (request === controller) { request = undefined; sync(); }
    }
  }

  header.addEventListener('change', () => {
    if (header.checked) for (const [id, file] of records) selection.set(id, file);
    else selection.clear();
    sync();
  });
  node('clear-selection').addEventListener('click', () => {
    clearSelection();
    header.focus({ preventScroll: true });
  });
  node('reset-search').addEventListener('click', () => { node('clear-filters').click(); });
  matching.addEventListener('click', () => { void selectMatching(); });
  async function selectMatching(): Promise<void> {
    const controller = new AbortController();
    collecting = controller;
    const started = revision;
    sync();
    try {
      const files = await collectFiles(options.view, search.values(), controller.signal);
      if (controller.signal.aborted || started !== revision) return;
      selection.clear();
      for (const file of files) selection.set(file.id, file);
      total = files.length;
      updateCount();
    } catch (error) {
      if (!controller.signal.aborted) toast(error instanceof Error ? error.message : 'Files could not be selected.');
    } finally {
      if (collecting === controller) collecting = undefined;
      sync();
    }
  }
  node('load-more').addEventListener('click', () => { void load(); });
  node('retry-list').addEventListener('click', () => { void load(retryReset || stale); });
  new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && loaded && cursor && (options.canAutoLoad?.() ?? true)) void load();
  }, { rootMargin: '160px' }).observe(node('scroll-sentinel'));

  return {
    refresh: () => load(true),
    ensureFresh: () => !loaded || stale ? load(true) : Promise.resolve(),
    invalidate: () => { stale = true; revision++; search.invalidate(); },
    fail, clearSelection,
    selected: () => [...selection.values()],
    setBusy(value: boolean, message = ''): void { busy = value; busyText = message; sync(); },
    insert(file: SharedFile): void {
      search.invalidate();
      if (search.active() || search.values().sort !== 'newest' || busy) { stale = true; return; }
      if (records.has(file.id)) return;
      revision++;
      append(file, true);
      total++;
      loaded = true;
      updateCount();
    },
    remove(id: string): void {
      revision++;
      [...rows.children].find(item => (item as HTMLElement).dataset.fileId === id)?.remove();
      selection.delete(id);
      if (records.delete(id)) total = Math.max(0, total - 1);
      search.invalidate();
      void search.refresh();
      updateCount();
    },
  };
}

export type FileListController = ReturnType<typeof createFileList>;
