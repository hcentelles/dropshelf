import { canPreview, formatSize } from '../shared/formats';
import { isFolder, type ShelfEntry } from '../shared/types';
import { copy, icon, identityLabel, initials } from './api';
import { entryUrl } from './navigation';

function text(tag: string, value: string, className = ''): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
}

function link(label: string, url: string, className = '', newTab = true): HTMLAnchorElement {
  const node = document.createElement('a');
  node.textContent = label;
  node.href = url;
  if (newTab) node.target = '_blank';
  node.rel = 'noopener noreferrer';
  node.className = className;
  return node;
}

interface FileActions {
  trash?: (file: ShelfEntry) => Promise<void>;
  restore?: (file: ShelfEntry) => Promise<void>;
  deletePermanently?: (file: ShelfEntry) => void;
}

export function fileRow(file: ShelfEntry, fresh: boolean, callbacks: FileActions): HTMLTableRowElement {
  const folder = isFolder(file);
  const inTrash = file.trashedAt !== null;
  const url = entryUrl(file, inTrash ? 'trash' : 'files');
  const row = document.createElement('tr');
  row.setAttribute('role', 'row');
  row.dataset.fileId = file.id;
  if (fresh) row.classList.add('is-new');
  const nameCell = document.createElement('td');
  nameCell.className = 'col-name';
  const nameWrap = text('div', '', 'file-name-wrap');
  const isImage = !folder && file.contentType.startsWith('image/');
  const preview = text('div', '', `file-preview ${folder ? 'folder-preview' : file.contentType === 'text/html' ? 'html-preview' : !isImage ? 'document-preview' : ''}`);
  if (!folder && !inTrash && canPreview(file.contentType) && file.contentType !== 'image/svg+xml') {
    const img = document.createElement('img');
    img.src = `/api/files/${file.id}/thumbnail`;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { img.remove(); preview.append(icon('image')); }, { once: true });
    preview.append(img);
  } else { preview.append(icon(folder ? 'folder' : file.contentType === 'text/html' ? 'file-code' : isImage ? 'image' : file.contentType === 'text/csv' ? 'table' : file.contentType === 'application/pdf' ? 'file-pdf' : 'file-text')); }
  const details = text('div', '', 'file-details');
  const title = text('div', '', 'file-title');
  title.append(inTrash && !folder ? text('span', file.name, 'file-name') : link(file.name, url, '', !folder));
  if (folder) title.append(icon('caret-right'));
  if (file.deletionPending) {
    const pending = text('span', 'Delete pending', 'pending-badge');
    pending.title = 'Permanent deletion has started. Use Retry permanent delete to finish.';
    title.append(pending);
  }
  if (fresh) title.append(text('span', 'New', 'new-badge'));
  const type = folder ? `${file.fileCount} ${file.fileCount === 1 ? 'file' : 'files'}`
    : file.contentType === 'text/html' ? 'HTML' : (file.name.split('.').at(-1) ?? 'Image').toUpperCase();
  const dateValue = file.trashedAt ?? file.createdAt;
  const uploaderName = identityLabel(file.uploaderLabel);
  const mobileMeta = text('div', `${uploaderName} · ${new Date(dateValue).toLocaleDateString('en')}`, 'mobile-meta');
  mobileMeta.title = mobileMeta.textContent ?? '';
  details.append(title, text('div', `${type} · ${formatSize(file.size)}`, 'file-meta'), mobileMeta);
  details.title = file.path;
  nameWrap.append(preview, details);
  nameCell.append(nameWrap);
  const uploader = document.createElement('td');
  uploader.className = 'col-author';
  const person = text('div', '', 'person');
  person.title = uploaderName;
  person.append(text('span', initials(file.uploaderLabel), 'avatar small'), text('span', uploaderName, 'person-label'));
  if (file.source === 'mcp') person.append(text('span', 'MCP', 'source-badge'));
  uploader.append(person);
  const linkCell = document.createElement('td');
  linkCell.className = 'col-link';
  if (inTrash) {
    const actor = text('span', identityLabel(file.trashedBy ?? ''), 'person-label trash-actor');
    actor.title = actor.textContent ?? '';
    linkCell.append(actor);
  } else {
    const fileLink = link(`…/${file.path}`, url, 'file-link', !folder);
    fileLink.title = url;
    fileLink.append(icon(folder ? 'folder-open' : 'arrow-square-out'));
    linkCell.append(fileLink);
  }
  const date = document.createElement('td');
  date.className = 'col-date';
  const time = document.createElement('time');
  time.dateTime = new Date(dateValue).toISOString();
  time.textContent = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(dateValue);
  time.title = new Date(dateValue).toLocaleString('en');
  date.append(time);
  const actions = document.createElement('td');
  actions.className = 'col-actions';
  const controls = text('div', '', 'row-actions');
  const copyButton = document.createElement('button');
  copyButton.className = 'copy-button';
  copyButton.append(icon(inTrash ? 'arrow-counter-clockwise' : 'copy'), text('span', inTrash ? 'Restore' : 'Copy link'));
  copyButton.setAttribute('aria-label', inTrash ? `Restore ${file.name}` : `Copy link for ${file.name}`);
  copyButton.disabled = !folder && file.deletionPending;
  if (!folder && file.deletionPending) copyButton.title = 'Permanent deletion has started. This file cannot be restored.';
  copyButton.addEventListener('click', () => {
    if (inTrash && callbacks.restore) void run(callbacks.restore);
    else void copy(url, 'Link copied.', undefined, copyButton);
  });
  const menu = document.createElement('details');
  menu.className = 'file-menu';
  const summary = document.createElement('summary');
  summary.className = 'icon-button';
  summary.setAttribute('aria-label', `More options for ${file.name}`);
  summary.append(icon('dots-three'));
  const panel = text('div', '', 'menu-panel');
  const remove = document.createElement('button');
  remove.className = 'menu-danger';
  remove.append(icon('trash'), text('span', inTrash ? file.deletionPending ? 'Retry permanent delete' : 'Delete permanently' : 'Move to Trash'));
  remove.addEventListener('click', () => {
    menu.open = false;
    if (inTrash) callbacks.deletePermanently?.(file);
    else if (callbacks.trash) void run(callbacks.trash);
  });
  if (!inTrash || folder) {
    const open = link(folder ? 'Open folder' : 'Open file', url, '', !folder);
    open.prepend(icon(folder ? 'folder-open' : 'arrow-square-out'));
    panel.append(open);
  }
  if (!inTrash && !folder) {
    const download = link('Download file', file.downloadUrl);
    download.prepend(icon('download-simple'));
    panel.append(download);
  }
  panel.append(remove);
  menu.append(summary, panel);
  controls.append(copyButton, menu);
  actions.append(controls);
  row.append(nameCell, uploader, linkCell, date, actions);
  for (const cell of row.cells) cell.setAttribute('role', 'cell');
  return row;

  async function run(action: (file: ShelfEntry) => Promise<void>): Promise<void> {
    const buttons = [...row.querySelectorAll('button')].map(button => ({ button, disabled: button.disabled }));
    for (const { button } of buttons) button.disabled = true;
    row.setAttribute('aria-busy', 'true');
    try { await action(file); }
    finally {
      for (const { button, disabled } of buttons) button.disabled = disabled;
      row.removeAttribute('aria-busy');
    }
  }
}
