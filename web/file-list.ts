import { isFolder, type ExplorerPage, type FileScope, type FileView, type SharedFile, type ShelfEntry } from '../shared/types';
import { api, element, icon, toast } from './api';
import { collectEntries, collectFiles, fileQuery, initFileSearch } from './file-search';
import { renderBreadcrumbs } from './navigation';

interface FileListOptions {
  prefix: string;
  view: FileView;
  render: (file: ShelfEntry) => HTMLTableRowElement;
  canAutoLoad?: () => boolean;
  onState?: (state: { total: number; busy: boolean; inFolder: boolean }) => void;
}

export function createFileList(options: FileListOptions) {
  const number = new Intl.NumberFormat('en');
  const node = (name: string) => element(`${options.prefix}${name}`);
  const rows = node('file-list');
  const header = node('select-all') as HTMLInputElement;
  const toolbar = node('bulk-toolbar');
  const matching = node('select-matching') as HTMLButtonElement;
  const records = new Map<string, ShelfEntry>();
  const selection = new Map<string, ShelfEntry>();
  let scope: FileScope = {};
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
  let livePending = false;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  const search = initFileSearch(options.prefix, options.view, fetch => {
    revision++;
    request?.abort();
    request = undefined;
    clearSelection();
    pending = true;
    sync();
    if (fetch) void load(true);
  }, () => { sync(); }, () => scope);

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
    node('selection-count').textContent = collecting ? 'Loading selection…' : busy ? busyText
      : `${number.format(selection.size)} selected${[...selection.values()].some(isFolder) ? ' · All folder contents included' : ''}`;
    matching.hidden = !selection.size || selection.size >= total || busy;
    matching.replaceChildren(icon('checks'), document.createTextNode(`Select all ${number.format(total)}`));
    matching.setAttribute('aria-label', `Select all ${number.format(total)} matching items`);
    for (const button of toolbar.querySelectorAll('button')) button.disabled = locked;
    for (const row of rows.querySelectorAll<HTMLTableRowElement>('tr')) {
      const selected = selection.has(row.dataset.fileId!);
      row.classList.toggle('is-selected', selected);
      row.querySelector<HTMLInputElement>('.file-select')!.checked = selected;
    }
    node('load-more').toggleAttribute('disabled', locked);
    options.onState?.({ total: search.total, busy: busy || !!collecting, inFolder: !!scope.folder });
    scheduleLive();
  }

  function clearSelection(): void {
    collecting?.abort();
    collecting = undefined;
    selection.clear();
    sync();
  }

  function updateCount(): void {
    node('file-count').textContent = `${number.format(total)} ${total === 1 ? 'item' : 'items'}${search.active() ? ' found' : ''}`;
    node('empty-state').hidden = total !== 0 || !loaded || search.active();
    node('no-results').hidden = total !== 0 || !loaded || !search.active();
    if (loaded && !cursor) node('list-status').textContent = total
      ? `You have reached the end of ${scope.folder ? 'this folder' : options.view === 'trash' ? 'Trash' : 'the shelf'}.` : '';
    sync();
  }

  function append(file: ShelfEntry, prepend = false): void {
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
    if (reset) { pending = true; livePending = false; }
    node('retry-list').hidden = true;
    node('load-more').hidden = true;
    node('list-status').textContent = reset ? 'Loading items…' : 'Loading more items…';
    sync();
    void search.refresh();
    try {
      const page: ExplorerPage = await api<ExplorerPage>(fileQuery(options.view, search.values(), reset ? null : cursor, undefined, true), { signal: controller.signal });
      if (controller.signal.aborted || started !== revision) return;
      if (reset) { records.clear(); rows.replaceChildren(); }
      for (const file of page.entries) append(file);
      cursor = page.nextCursor;
      total = page.total;
      loaded = true;
      stale = livePending;
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

  function scheduleLive(): void {
    if (!livePending || liveTimer || request || busy || pending || collecting ||
      rows.closest('[hidden]') || !(options.canAutoLoad?.() ?? true) ||
      rows.querySelector('details[open]') || document.querySelector('dialog[open]')) return;
    liveTimer = setTimeout(() => { liveTimer = undefined; void refreshLive(); }, 200);
  }

  async function refreshLive(): Promise<void> {
    if (!livePending || request || busy || pending || collecting || rows.closest('[hidden]') ||
      !(options.canAutoLoad?.() ?? true) || rows.querySelector('details[open]') || document.querySelector('dialog[open]')) return;
    livePending = false;
    const controller = new AbortController();
    request = controller;
    const started = revision;
    try {
      const next = new Map<string, ShelfEntry>();
      let nextCursor: string | null = null;
      let count = 0;
      let target = Math.max(records.size, selection.size, 30);
      do {
        const page: ExplorerPage = await api<ExplorerPage>(fileQuery(options.view, search.values(), nextCursor, Math.min(100, target - next.size), true), { signal: controller.signal });
        if (controller.signal.aborted || started !== revision) return;
        if (!next.size && loaded && records.size) target += Math.min(30, Math.max(0, page.total - total));
        for (const entry of page.entries) next.set(entry.id, entry);
        count = page.total;
        nextCursor = page.nextCursor;
      } while (nextCursor && next.size < target);

      const oldRows = new Map([...rows.querySelectorAll<HTMLTableRowElement>('tr')].map(row => [row.dataset.fileId!, row]));
      const focused = document.activeElement instanceof HTMLElement && rows.contains(document.activeElement) ? document.activeElement : null;
      const focusedId = focused?.closest<HTMLTableRowElement>('tr')?.dataset.fileId;
      const focusedLabel = focused?.getAttribute('aria-label');
      const focusIndex = focused ? [...focused.closest('tr')!.querySelectorAll('a, button, input, summary')].indexOf(focused) : -1;
      const anchor = [...oldRows.values()].find(row => row.getBoundingClientRect().bottom > 0);
      const anchorTop = anchor?.getBoundingClientRect().top;
      const before = new Map(records);
      records.clear();
      for (const [id, row] of oldRows) if (!next.has(id)) row.remove();
      for (const [id] of selection) {
        const current = next.get(id);
        if (current) selection.set(id, current); else selection.delete(id);
      }
      let index = 0;
      for (const entry of next.values()) {
        const old = oldRows.get(entry.id);
        let row: HTMLTableRowElement;
        if (old && JSON.stringify(before.get(entry.id)) === JSON.stringify(entry)) {
          records.set(entry.id, entry);
          row = old;
        } else {
          old?.remove();
          append(entry);
          row = rows.lastElementChild as HTMLTableRowElement;
        }
        if (rows.children[index] !== row) rows.insertBefore(row, rows.children[index] ?? null);
        index++;
      }
      if (focusedId) {
        const row = rows.querySelector<HTMLElement>(`tr[data-file-id="${CSS.escape(focusedId)}"]`);
        const target = focusedLabel ? row?.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focusedLabel)}"]`)
          : row?.querySelectorAll<HTMLElement>('a, button, input, summary')[focusIndex];
        target?.focus({ preventScroll: true });
      }
      if (anchor && anchorTop !== undefined) {
        const current = rows.querySelector<HTMLElement>(`tr[data-file-id="${CSS.escape(anchor.dataset.fileId!)}"]`);
        if (current) window.scrollBy(0, current.getBoundingClientRect().top - anchorTop);
      }
      cursor = nextCursor;
      total = count;
      loaded = true;
      stale = livePending;
      node('retry-list').hidden = true;
      node('load-more').hidden = !cursor;
      updateCount();
      if (cursor) node('list-status').textContent = '';
      void search.refresh();
    } catch (error) {
      if (!controller.signal.aborted && started === revision) {
        stale = true;
        retryReset = true;
        fail(error instanceof Error ? error.message : 'Live changes could not be loaded.');
        liveTimer = setTimeout(() => { liveTimer = undefined; requestLiveUpdate(); }, 5000);
      }
    } finally {
      if (request === controller) { request = undefined; sync(); }
    }
  }

  function requestLiveUpdate(): void {
    livePending = true;
    stale = true;
    search.invalidate();
    scheduleLive();
  }
  document.addEventListener('toggle', scheduleLive, true);
  document.addEventListener('close', scheduleLive, true);

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
      const files = await collectEntries(options.view, search.values(), controller.signal);
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

  async function resolveEntries(entries: ShelfEntry[]): Promise<SharedFile[]> {
    const controller = new AbortController();
    collecting?.abort();
    collecting = controller;
    const started = revision;
    sync();
    try {
      const files = new Map<string, SharedFile>();
      for (const entry of entries) {
        const children = isFolder(entry)
          ? await collectFiles(options.view, { uploadId: entry.uploadId, folder: entry.path }, controller.signal) : [entry];
        if (controller.signal.aborted || started !== revision) return [];
        for (const file of children) files.set(file.id, file);
      }
      return [...files.values()];
    } catch (error) {
      if (!controller.signal.aborted) toast(error instanceof Error ? error.message : 'The folder contents could not be loaded.');
      return [];
    } finally {
      if (collecting === controller) collecting = undefined;
      sync();
    }
  }

  function setScope(next: FileScope): void {
    if ((scope.folder ?? '') === (next.folder ?? '') && (scope.uploadId ?? '') === (next.uploadId ?? '')) return;
    scope = { ...next };
    revision++;
    request?.abort();
    request = undefined;
    pending = false;
    livePending = false;
    clearTimeout(liveTimer);
    liveTimer = undefined;
    clearSelection();
    search.reset();
    records.clear();
    rows.replaceChildren();
    cursor = null;
    loaded = false;
    stale = true;
    renderBreadcrumbs(node('breadcrumbs'), options.view, scope);
    node('files-heading').textContent = scope.folder?.split('/').at(-1) || (options.view === 'files' ? 'All files' : 'Files in Trash');
    const empty = node('empty-state');
    empty.querySelector('h3')!.textContent = scope.folder ? 'This folder is empty' : options.view === 'files' ? 'Your shelf is ready' : 'Trash is empty';
    empty.querySelector('p')!.textContent = scope.folder ? 'Use the path above to open a parent folder.'
      : options.view === 'files' ? 'Drop your first file above. Your team’s files will appear here.' : 'Files moved to Trash will appear here.';
    updateCount();
  }

  return {
    refresh: () => load(true),
    ensureFresh: () => !loaded || stale ? load(true) : Promise.resolve(),
    invalidate: () => { stale = true; revision++; search.invalidate(); },
    fail, clearSelection, setScope, resolveEntries, requestLiveUpdate,
    selected: () => [...selection.values()],
    setBusy(value: boolean, message = ''): void { busy = value; busyText = message; sync(); },
    insert(_file: SharedFile): void {
      search.invalidate();
      stale = true;
    },
  };
}

export type FileListController = ReturnType<typeof createFileList>;
