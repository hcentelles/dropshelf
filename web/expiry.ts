import type { ExplorerEntry } from '../shared/types';
import { expiryText } from '../shared/expiry-format';

const displays = new WeakMap<HTMLElement, { file: ExplorerEntry; compact: boolean }>();

export function refreshExpiryDisplay(node: HTMLElement): void {
  const data = displays.get(node);
  if (!data) return;
  const value = expiryText(data.file);
  node.querySelector('.expiry-summary')!.textContent = data.compact ? value.short : value.summary;
  node.classList.toggle('expiry-urgent', value.urgent);
  if (data.compact) {
    node.querySelector('.expiry-mobile-summary')!.textContent = value.summary;
    node.title = `${value.summary}. ${value.detail}`;
  } else node.querySelector('.expiry-detail')!.textContent = value.detail;
}

export function expiryDisplay(file: ExplorerEntry, compact = false): HTMLElement {
  const node = document.createElement(compact ? 'span' : 'div');
  node.className = `expiry-content${compact ? ' expiry-compact' : ''}`;
  const summary = document.createElement('span');
  summary.className = 'expiry-summary';
  const detail = document.createElement('span');
  detail.className = compact ? 'expiry-mobile-summary' : 'expiry-detail';
  node.append(summary, detail);
  displays.set(node, { file, compact });
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
