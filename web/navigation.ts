import { element } from './api';
import { isFolder, type FileScope, type FileView, type ShelfEntry } from '../shared/types';

export type Section = 'files' | 'trash' | 'mcp';

export function currentSection(): Section {
  const section = window.location.hash.split('?')[0];
  return section === '#mcp' ? 'mcp' : section === '#trash' ? 'trash' : 'files';
}

export function currentScope(): FileScope {
  const query = new URLSearchParams(window.location.hash.split('?')[1]);
  return { uploadId: query.get('uploadId') ?? '', folder: query.get('folder') ?? '' };
}

export function folderHref(view: FileView, scope: FileScope = {}): string {
  return scope.folder ? `#${view}?${new URLSearchParams({ uploadId: scope.uploadId ?? '', folder: scope.folder })}` : view === 'files' ? '#' : '#trash';
}

export function entryUrl(entry: ShelfEntry, view: FileView = 'files'): string {
  return isFolder(entry) ? `${window.location.origin}/${folderHref(view, { uploadId: entry.uploadId, folder: entry.path })}` : entry.url;
}

export function renderBreadcrumbs(node: HTMLElement, view: FileView, scope: FileScope): void {
  node.replaceChildren();
  node.hidden = !scope.folder;
  const parts = scope.folder?.split('/') ?? [];
  const labels = [view === 'files' ? 'All files' : 'Trash', ...parts];
  labels.forEach((label, index) => {
    if (index) { const separator = document.createElement('span'); separator.textContent = '/'; separator.setAttribute('aria-hidden', 'true'); node.append(separator); }
    const item = document.createElement(index === labels.length - 1 ? 'span' : 'a');
    item.textContent = label;
    if (item instanceof HTMLAnchorElement) item.href = folderHref(view, { uploadId: scope.uploadId, folder: parts.slice(0, index).join('/') });
    else item.setAttribute('aria-current', 'page');
    node.append(item);
  });
}

export function initNavigation(onSection: (section: Section) => void): void {
  const sections = {
    files: { view: element('files-view'), heading: element('files-page-heading') },
    trash: { view: element('trash-view'), heading: element('trash-heading') },
    mcp: { view: element('mcp-view'), heading: element('mcp-heading') },
  };
  const scroll = new Map<string, number>();
  let previous = window.location.hash;

  function show(focus: boolean): void {
    const section = currentSection();
    element('current-section').textContent = section === 'trash' ? 'Trash' : section === 'mcp' ? 'Connect MCP' : 'Files';
    if (focus) scroll.set(previous, window.scrollY);
    for (const [name, nodes] of Object.entries(sections)) nodes.view.hidden = name !== section;
    for (const menu of document.querySelectorAll<HTMLDetailsElement>('.account-menu[open]')) menu.open = false;
    onSection(section);
    if (focus) {
      sections[section].heading.focus({ preventScroll: true });
      window.scrollTo(0, scroll.get(window.location.hash) ?? 0);
    }
    previous = window.location.hash;
  }

  window.addEventListener('hashchange', () => { show(true); });
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-section]')) {
    link.addEventListener('click', () => { if (link.hash === window.location.hash) show(true); });
  }
  show(false);
}
