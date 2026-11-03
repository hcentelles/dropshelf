import type { ExplorerEntry } from '../shared/types';
import { expiryText } from '../shared/expiry-format';

type ExpiryDisplayMode = 'detail' | 'compact' | 'menu';
const displays = new WeakMap<HTMLElement, { file: ExplorerEntry; mode: ExpiryDisplayMode }>();

export function refreshExpiryDisplay(node: HTMLElement): void {
  const data = displays.get(node);
  if (!data) return;
  const now = Date.now();
  const value = expiryText(data.file, now);
  const summary = node.querySelector('.expiry-summary')!;
  summary.textContent = data.mode === 'compact' ? value.short : value.summary;
  node.classList.toggle('expiry-urgent', value.urgent);
  if (data.mode === 'menu') {
    summary.textContent = data.file.expiry ? `${value.short}${data.file.expiry.firstAt > now ? ' left' : ''}` : value.summary;
    node.querySelector('.expiry-detail')!.textContent = data.file.permanentCount && !data.file.permanent ? 'Some files are permanent' : '';
    node.title = `${value.summary}. ${value.detail}`;
  } else if (data.mode === 'compact') {
    node.querySelector('.expiry-mobile-summary')!.textContent = value.summary;
    node.title = `${value.summary}. ${value.detail}`;
  } else node.querySelector('.expiry-detail')!.textContent = value.detail;
}

export function expiryDisplay(file: ExplorerEntry, mode: ExpiryDisplayMode = 'detail'): HTMLElement {
  const node = document.createElement(mode === 'compact' ? 'span' : 'div');
  node.className = `expiry-content${mode === 'detail' ? '' : ` expiry-${mode}`}`;
  const summary = document.createElement('span');
  summary.className = 'expiry-summary';
  const detail = document.createElement('span');
  detail.className = mode === 'compact' ? 'expiry-mobile-summary' : 'expiry-detail';
  node.append(summary, detail);
  displays.set(node, { file, mode });
  refreshExpiryDisplay(node);
  return node;
}

export function initExpiryUpdates(): void {
  const refresh = () => {
    if (!document.hidden) for (const node of document.querySelectorAll<HTMLElement>('.expiry-content')) refreshExpiryDisplay(node);
  };
  window.setInterval(refresh, 60_000);
  document.addEventListener('visibilitychange', refresh);
}
