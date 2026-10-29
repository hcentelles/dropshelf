import { fileTypeLabel } from '../shared/formats';
import type { ExplorerPage, FileScope, FileQuery, FileSort, FileFilterOptions, FilePage, FileView, SharedFile, ShelfEntry } from '../shared/types';
import { api, element, identityLabel } from './api';

export function fileQuery(view: FileView, filters: FileQuery, cursor?: string | null, limit?: number, explorer = false): string {
  const query = new URLSearchParams({ view });
  if (filters.q) query.set('q', filters.q);
  if (filters.type) query.set('type', filters.type);
  if (filters.author) query.set('author', filters.author);
  if (filters.sort) query.set('sort', filters.sort);
  if (filters.uploadId) query.set('uploadId', filters.uploadId);
  if (filters.folder) query.set('folder', filters.folder);
  if (cursor) query.set('cursor', cursor);
  if (limit) query.set('limit', String(limit));
  return `/api/${explorer ? 'explorer' : 'files'}?${query}`;
}

export async function collectEntries(view: FileView, filters: FileQuery, signal?: AbortSignal): Promise<ShelfEntry[]> {
  const entries = new Map<string, ShelfEntry>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: ExplorerPage = await api(fileQuery(view, filters, cursor, 100, true), { signal });
    for (const entry of page.entries) entries.set(entry.id, entry);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('The folder list did not advance. Try again.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...entries.values()];
}

export async function collectFiles(view: FileView, filters: FileQuery, signal?: AbortSignal): Promise<SharedFile[]> {
  const files = new Map<string, SharedFile>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: FilePage = await api(fileQuery(view, filters, cursor, 100), { signal });
    for (const file of page.files) files.set(file.id, file);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('The file list did not advance. Reload the page and try again.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...files.values()];
}

export function initFileSearch(prefix: string, view: FileView, changed: (fetch: boolean) => void, onTotal?: (total: number) => void,
  scope: () => FileScope = () => ({})) {
  const q = element<HTMLInputElement>(`${prefix}search`);
  const type = element<HTMLSelectElement>(`${prefix}filter-type`);
  const author = element<HTMLSelectElement>(`${prefix}filter-author`);
  const sort = element<HTMLSelectElement>(`${prefix}sort`);
  const clear = element<HTMLButtonElement>(`${prefix}clear-filters`);
  const labels = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout>;
  let dirty = true;
  let fetching = false;
  let revision = 0;
  let total = 0;

  const values = (): FileQuery => ({ ...scope(), q: q.value.trim().normalize('NFC'), type: type.value, author: author.value, sort: sort.value as FileSort });
  const active = () => !!(q.value.trim() || type.value || author.value);
  function change(debounce: boolean): void {
    clearTimeout(timer);
    clear.hidden = !active();
    changed(false);
    if (debounce) timer = setTimeout(() => { changed(true); }, 250);
    else changed(true);
  }
  q.addEventListener('input', () => { change(true); });
  type.addEventListener('change', () => { change(false); });
  author.addEventListener('change', () => { change(false); });
  sort.addEventListener('change', () => { change(false); });
  clear.addEventListener('click', () => { q.value = ''; type.value = ''; author.value = ''; change(false); q.focus(); });

  function options(select: HTMLSelectElement, first: string, entries: FileFilterOptions['types'], fallback: string): void {
    const selected = select.value;
    select.replaceChildren(new Option(first, ''));
    for (const entry of entries) select.add(new Option(`${entry.label} (${entry.count})`, entry.value));
    if (selected && !entries.some(entry => entry.value === selected)) select.add(new Option(`${fallback} (0)`, selected));
    select.value = selected;
  }

  async function refresh(): Promise<void> {
    if (!dirty || fetching) return;
    fetching = true;
    const started = revision;
    try {
      const result = await api<FileFilterOptions>(fileQuery(view, scope()).replace('/api/files?', '/api/files/filters?'));
      if (started !== revision) return;
      const authors = result.authors.map(entry => ({ ...entry, label: identityLabel(entry.label) }));
      for (const entry of authors) labels.set(entry.value, entry.label);
      options(type, 'All file types', result.types, fileTypeLabel(type.value));
      options(author, 'All authors', authors, labels.get(author.value) ?? 'Selected author');
      total = result.total;
      dirty = false;
      onTotal?.(total);
    } catch { /* The file list shows connection errors; keep usable filter values. */ }
    finally {
      fetching = false;
      if (started !== revision) void refresh();
    }
  }

  return {
    values, active, refresh,
    reset(): void { clearTimeout(timer); q.value = ''; type.value = ''; author.value = ''; clear.hidden = true; dirty = true; revision++; },
    invalidate: () => { dirty = true; revision++; },
    get total() { return total; },
    lock(locked: boolean): void { q.disabled = locked; type.disabled = locked; author.disabled = locked; sort.disabled = locked; clear.disabled = locked; },
  };
}
