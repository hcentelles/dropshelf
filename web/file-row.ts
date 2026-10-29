import { canPreview, formatSize } from '../shared/formats';
import type { SharedFile } from '../shared/types';
import { copy, icon, initials } from './api';

function text(tag: string, value: string, className = ''): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
}

function link(label: string, url: string, className = ''): HTMLAnchorElement {
  const node = document.createElement('a');
  node.textContent = label;
  node.href = url;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  node.className = className;
  return node;
}

interface FileActions {
  trash?: (file: SharedFile) => Promise<void>;
  restore?: (file: SharedFile) => Promise<void>;
  deletePermanently?: (file: SharedFile) => void;
}

export function fileRow(file: SharedFile, fresh: boolean, callbacks: FileActions): HTMLTableRowElement {
  const inTrash = file.trashedAt !== null;
  const row = document.createElement('tr');
  row.setAttribute('role', 'row');
  row.dataset.fileId = file.id;
  if (fresh) row.classList.add('is-new');
  const nameCell = document.createElement('td');
  nameCell.className = 'col-name';
  const nameWrap = text('div', '', 'file-name-wrap');
  const isImage = file.contentType.startsWith('image/');
  const preview = text('div', '', `file-preview ${file.contentType === 'text/html' ? 'html-preview' : !isImage ? 'document-preview' : ''}`);
  if (!inTrash && canPreview(file.contentType) && file.contentType !== 'image/svg+xml') {
    const img = document.createElement('img');
    img.src = `/api/files/${file.id}/thumbnail`;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { img.remove(); preview.append(icon('image')); }, { once: true });
    preview.append(img);
  } else { preview.append(icon(file.contentType === 'text/html' ? 'file-code' : isImage ? 'image' : file.contentType === 'text/csv' ? 'table' : file.contentType === 'application/pdf' ? 'file-pdf' : 'file-text')); }
  const details = text('div', '', 'file-details');
  const title = text('div', '', 'file-title');
  title.append(inTrash ? text('span', file.name, 'file-name') : link(file.name, file.url));
  if (file.deletionPending) {
    const pending = text('span', 'Delete pending', 'pending-badge');
    pending.title = 'Permanent deletion has started. Use Retry permanent delete to finish.';
    title.append(pending);
  }
  if (fresh) title.append(text('span', 'New', 'new-badge'));
  const type = file.contentType === 'text/html' ? 'HTML' : (file.name.split('.').at(-1) ?? 'Image').toUpperCase();
  const dateValue = file.trashedAt ?? file.createdAt;
  const mobileMeta = text('div', `${file.uploaderLabel} · ${new Date(dateValue).toLocaleDateString('en')}`, 'mobile-meta');
  mobileMeta.title = mobileMeta.textContent ?? '';
  details.append(title, text('div', `${type} · ${formatSize(file.size)}`, 'file-meta'), mobileMeta);
  details.title = file.path;
  nameWrap.append(preview, details);
  nameCell.append(nameWrap);
  const uploader = document.createElement('td');
  uploader.className = 'col-author';
  const person = text('div', '', 'person');
  person.title = file.uploaderLabel;
  person.append(text('span', initials(file.uploaderLabel), 'avatar small'), text('span', file.uploaderLabel, 'person-label'));
  if (file.source === 'mcp') person.append(text('span', 'MCP', 'source-badge'));
  uploader.append(person);
  const linkCell = document.createElement('td');
  linkCell.className = 'col-link';
  if (inTrash) {
    const actor = text('span', file.trashedBy ?? '', 'person-label trash-actor');
    actor.title = file.trashedBy ?? '';
    linkCell.append(actor);
  } else {
    const fileLink = link(`…/${file.path}`, file.url, 'file-link');
    fileLink.title = file.url;
    fileLink.append(icon('arrow-square-out'));
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
  copyButton.disabled = file.deletionPending;
  if (file.deletionPending) copyButton.title = 'Permanent deletion has started. This file cannot be restored.';
  copyButton.addEventListener('click', () => {
    if (inTrash && callbacks.restore) void run(callbacks.restore);
    else void copy(file.url, 'Link copied.', undefined, copyButton);
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
  if (!inTrash) {
    const open = link('Open file', file.url);
    open.prepend(icon('arrow-square-out'));
    const download = link('Download file', file.downloadUrl);
    download.prepend(icon('download-simple'));
    panel.append(open, download);
  }
  panel.append(remove);
  menu.append(summary, panel);
  controls.append(copyButton, menu);
  actions.append(controls);
  row.append(nameCell, uploader, linkCell, date, actions);
  for (const cell of row.cells) cell.setAttribute('role', 'cell');
  return row;

  async function run(action: (file: SharedFile) => Promise<void>): Promise<void> {
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
