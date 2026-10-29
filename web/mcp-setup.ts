import { describeAllowedTypes, formatSize } from '../shared/formats';
import type { AppConfig } from '../shared/types';
import { copy, element } from './api';

export function initMcpSetup(): void {
  element('copy-mcp-url').addEventListener('click', () => {
    void copy(element<HTMLInputElement>('mcp-server-url').value,
      'MCP URL copied.', 'Copy failed. Select the server URL and copy it.');
  });
  element('copy-mcp-command').addEventListener('click', () => {
    void copy(element('mcp-codex-command').textContent ?? '',
      'Commands copied.', 'Copy failed. Select the commands and copy them.');
  });
}

export function updateMcpSetup(config: AppConfig): void {
  element<HTMLInputElement>('mcp-server-url').value = config.mcpUrl;
  element('mcp-codex-command').textContent = `codex mcp add dropshelf --url ${config.mcpUrl}`
    + (config.local ? '' : '\ncodex mcp login dropshelf');
  element('mcp-allowed-types').textContent = `${describeAllowedTypes(config.allowedFileTypes)}.`;
  element('mcp-file-limit').textContent = `up to ${formatSize(config.maxFileBytes)} per file.`;
  element<HTMLButtonElement>('copy-mcp-url').disabled = false;
  element<HTMLButtonElement>('copy-mcp-command').disabled = false;
  if (config.local) {
    element('mcp-local-note').hidden = false;
    element('mcp-auth-method').textContent = 'Local test identity';
    element('mcp-sign-in').textContent = 'Local development uses the configured test identity. OAuth sign-in applies to deployed instances.';
    element('mcp-auth-note').hidden = true;
    element('mcp-check-identity').textContent = 'The identity should show the local developer email address.';
  }
}

export function showMcpSetupError(message: string): void {
  element('mcp-connection-error').textContent = message;
  element('mcp-connection-error').hidden = false;
  element<HTMLInputElement>('mcp-server-url').placeholder = 'Connection required';
  element('mcp-codex-command').textContent = 'Reload the page to connect.';
  element('mcp-allowed-types').textContent = 'Connection required.';
  element('mcp-file-limit').textContent = 'Connection required.';
}
