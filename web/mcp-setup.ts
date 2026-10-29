import { describeAllowedTypes, formatSize } from '../shared/formats';
import type { AppConfig } from '../shared/types';
import { copy, element } from './api';

export function initMcpSetup(): void {
  element('copy-mcp-instructions').addEventListener('click', async () => {
    const instructions = element<HTMLTextAreaElement>('mcp-agent-instructions');
    if (!await copy(instructions.value, 'Instructions copied.', 'Copy failed. Copy the selected instructions.')) {
      instructions.focus();
      instructions.select();
    }
  });
  element('copy-mcp-url').addEventListener('click', () => {
    void copy(element<HTMLInputElement>('mcp-server-url').value,
      'MCP URL copied.', 'Copy failed. Select the server URL and copy it.');
  });
  element('copy-mcp-command').addEventListener('click', () => {
    void copy(element('mcp-codex-command').textContent ?? '',
      'Commands copied.', 'Copy failed. Select the commands and copy them.');
  });
}

function agentSetupInstructions(config: AppConfig): string {
  const authentication = config.local
    ? 'This is a local development instance with a test identity. Do not configure OAuth or add authentication headers.'
    : "Use the client's built-in OAuth flow with Cloudflare Access. Use the server's discovery metadata and dynamic client registration. The client must support OAuth resource indicators (RFC 8707). Start sign-in and open the authorization URL, or give it to me if you cannot open a browser. Let me enter the email code and approve access. Let the client store and refresh its tokens. Do not ask me to paste tokens, cookies, or secrets into this chat. If Access rejects the callback URL, report the exact URL that the instance administrator must allow.";

  return `Configure this remote MCP server for the agent I am using. Complete the setup with the tools and permissions available to you.

Server: ${config.name}
URL: ${config.mcpUrl}
Transport: Streamable HTTP
Authentication: ${config.local ? 'Local test identity' : 'OAuth through Cloudflare Access'}

1. Find the current client's supported MCP settings or setup commands. Add a persistent remote server named "dropshelf". Preserve other servers and settings. Reuse an entry with this URL. If the name is already used for another URL, choose a unique name.
2. ${authentication}
3. Reload the connection or restart the client if required. If you cannot do a required step, tell me the exact action I must take. Do not replace authentication with a static token or create a custom session service.
4. Discover the server tools. Call whoami, then list_files with limit 1. An empty file list is a valid result. Do not upload, change, or delete files during setup.
5. Report the server name, where you saved the settings, the verified identity, and the result of both tool calls. Only report success after both calls succeed. If this client lacks remote MCP or the required authentication support, explain the limit and the next required step.`;
}

export function updateMcpSetup(config: AppConfig): void {
  element<HTMLTextAreaElement>('mcp-agent-instructions').value = agentSetupInstructions(config);
  element<HTMLButtonElement>('copy-mcp-instructions').disabled = false;
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
  element<HTMLTextAreaElement>('mcp-agent-instructions').value = '';
  element<HTMLTextAreaElement>('mcp-agent-instructions').placeholder = 'Reload the page to load the setup instructions.';
  element<HTMLButtonElement>('copy-mcp-instructions').disabled = true;
  element('mcp-connection-error').textContent = message;
  element('mcp-connection-error').hidden = false;
  element<HTMLInputElement>('mcp-server-url').placeholder = 'Connection required';
  element('mcp-codex-command').textContent = 'Reload the page to connect.';
  element('mcp-allowed-types').textContent = 'Connection required.';
  element('mcp-file-limit').textContent = 'Connection required.';
}
