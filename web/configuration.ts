import { formatSize } from '../shared/formats';
import type { AppConfig } from '../shared/types';
import { api, ApiError, element } from './api';

function showConfiguration(config: AppConfig): void {
  const set = (name: string, value: string) => { element(`configuration-${name}`).textContent = value; };
  set('file-size', formatSize(config.maxFileBytes));
  set('file-bytes', `${config.maxFileBytes.toLocaleString('en')} bytes`);
  element('configuration-file-types').replaceChildren(...config.allowedFileTypes.map(type => {
    const tag = document.createElement('code');
    tag.textContent = type;
    return tag;
  }));
  const period = (days: number) => days ? `${days} ${days === 1 ? 'day' : 'days'}` : 'Off';
  set('file-days', period(config.retention.fileDays));
  set('file-days-note', config.retention.fileDays
    ? 'From the last upload, replacement, or restore.' : 'Files stay until you move them to Trash.');
  set('trash-days', period(config.retention.trashDays));
  set('trash-days-note', config.retention.trashDays
    ? 'From the time each file moves to Trash.' : 'Files stay in Trash until you delete them.');
  set('name', config.name);
  set('app-url', config.appOrigin);
  set('content-url', config.contentOrigin);
  set('mcp-url', config.mcpUrl);
  set('auth', config.local ? 'Local development identity' : 'Cloudflare Access');
}

export function initConfiguration(): void {
  const dialog = element<HTMLDialogElement>('configuration-dialog');
  const trigger = element<HTMLButtonElement>('view-configuration');
  const menu = trigger.closest<HTMLDetailsElement>('details')!;
  const body = element('configuration-body');
  const loading = element('configuration-loading');
  const values = element('configuration-values');
  const errorBox = element('configuration-error');
  let request: AbortController | undefined;

  async function refresh(): Promise<void> {
    request?.abort();
    const current = new AbortController();
    request = current;
    if (errorBox.contains(document.activeElement)) dialog.querySelector<HTMLElement>('[autofocus]')?.focus();
    values.hidden = true;
    errorBox.hidden = true;
    loading.hidden = false;
    body.setAttribute('aria-busy', 'true');
    try {
      const config = await api<AppConfig>('/api/config', { signal: current.signal, cache: 'no-store' });
      if (current.signal.aborted) return;
      showConfiguration(config);
      values.hidden = false;
    } catch (error) {
      if (current.signal.aborted) return;
      element('configuration-error-message').textContent = error instanceof ApiError
        ? error.message : 'The configuration could not be loaded. Try again.';
      errorBox.hidden = false;
    } finally {
      if (request === current) {
        loading.hidden = true;
        body.setAttribute('aria-busy', 'false');
      }
    }
  }

  trigger.addEventListener('click', () => {
    menu.open = false;
    dialog.showModal();
    body.scrollTop = 0;
    void refresh();
  });
  element('configuration-retry').addEventListener('click', () => { void refresh(); });
  dialog.addEventListener('close', () => {
    request?.abort();
    menu.querySelector('summary')?.focus();
  });
}
