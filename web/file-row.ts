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

export function fileRow(file: SharedFile, fresh: boolean): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.dataset.fileId = file.id;
  if (fresh) row.classList.add('is-new');
  const nameCell = document.createElement('td');
  const nameWrap = text('div', '', 'file-name-wrap');
  const isImage = file.contentType.startsWith('image/');
  const preview = text('div', '', `file-preview ${file.contentType === 'text/html' ? 'html-preview' : !isImage ? 'document-preview' : ''}`);
  if (canPreview(file.contentType) && file.contentType !== 'image/svg+xml') {
    const img = document.createElement('img');
    img.src = `/api/files/${file.id}/thumbnail`;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { img.remove(); preview.append(icon('image')); }, { once: true });
    preview.append(img);
  } else { preview.append(icon(file.contentType === 'text/html' ? 'file-code' : isImage ? 'image' : file.contentType === 'text/csv' ? 'table' : 'file-text')); }
  const details = text('div', '', 'file-details');
  const title = text('div', '', 'file-title');
  title.append(link(file.name, file.url));
  if (fresh) title.append(text('span', 'New', 'new-badge'));
  const type = file.contentType === 'text/html' ? 'HTML' : (file.name.split('.').at(-1) ?? 'Image').toUpperCase();
  const mobileMeta = text('div', `${file.uploaderLabel} · ${new Date(file.createdAt).toLocaleDateString('en')}`, 'mobile-meta');
  details.append(title, text('div', `${type} · ${formatSize(file.size)}`, 'file-meta'), mobileMeta);
  details.title = file.path;
  nameWrap.append(preview, details);
  nameCell.append(nameWrap);
  const uploader = document.createElement('td');
  const person = text('div', '', 'person');
  person.append(text('span', initials(file.uploaderLabel), 'avatar small'), text('span', file.uploaderLabel, 'person-label'));
  if (file.source === 'mcp') person.append(text('span', 'MCP', 'source-badge'));
  uploader.append(person);
  const linkCell = document.createElement('td');
  const fileLink = link(`…/${file.path}`, file.url, 'file-link');
  fileLink.title = file.url;
  fileLink.append(icon('arrow-square-out'));
  linkCell.append(fileLink);
  const date = document.createElement('td');
  const time = document.createElement('time');
  time.dateTime = new Date(file.createdAt).toISOString();
  time.textContent = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(file.createdAt);
  time.title = new Date(file.createdAt).toLocaleString('en');
  date.append(time);
  const actions = document.createElement('td');
  const controls = text('div', '', 'row-actions');
  const copyButton = document.createElement('button');
  copyButton.className = 'copy-button';
  copyButton.append(icon('copy'), text('span', 'Copy link'));
  copyButton.setAttribute('aria-label', `Copy link for ${file.name}`);
  copyButton.addEventListener('click', () => { void copy(file.url); });
  const menu = document.createElement('details');
  menu.className = 'file-menu';
  const summary = document.createElement('summary');
  summary.className = 'icon-button';
  summary.setAttribute('aria-label', `More options for ${file.name}`);
  summary.append(icon('dots-three'));
  const panel = text('div', '', 'menu-panel');
  panel.append(link('Open file', file.url), link('Download file', file.downloadUrl));
  menu.append(summary, panel);
  controls.append(copyButton, menu);
  actions.append(controls);
  row.append(nameCell, uploader, linkCell, date, actions);
  return row;
}
