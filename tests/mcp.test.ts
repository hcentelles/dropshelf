import { env, exports } from 'cloudflare:workers';
import { beforeAll, expect, it } from 'vitest';
import schema from '../migrations/0001_files.sql?raw';

beforeAll(async () => {
  await env.DB.batch(schema.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => env.DB.prepare(sql)));
});

async function rpc(method: string, params: unknown = {}, id = 1) {
  const response = await exports.default.fetch('http://localhost:8787/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Host: 'localhost:8787' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const body = await response.text();
  if (response.headers.get('Content-Type')?.includes('text/event-stream')) {
    const data = body.split('\n').find(line => line.startsWith('data: '));
    return { response, result: JSON.parse(data?.slice(6) ?? '{}') };
  }
  return { response, result: JSON.parse(body) };
}

it('supports MCP initialization, tool discovery, and an upload with the server identity', async () => {
  const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } });
  expect(initialized.response.status, JSON.stringify(initialized.result)).toBe(200);
  expect(initialized.result.result.serverInfo.name).toBe('dropshelf');
  const tools = await rpc('tools/list');
  expect(tools.result.result.tools.map((tool: { name: string }) => tool.name)).toContain('upload_file');
  const identity = await rpc('tools/call', { name: 'whoami', arguments: {} });
  expect(JSON.parse(identity.result.result.content[0].text).email).toBe('developer@example.test');
  const uploaded = await rpc('tools/call', { name: 'upload_file', arguments: { path: 'agent-page.html', content: '<h1>From an agent</h1>' } });
  expect(uploaded.result.result.isError).not.toBe(true);
  const file = JSON.parse(uploaded.result.result.content[0].text);
  expect(file.source).toBe('mcp');
  expect(file.uploaderEmail).toBe('developer@example.test');
  const html = await exports.default.fetch(file.url);
  expect(await html.text()).toBe('<h1>From an agent</h1>');
});
