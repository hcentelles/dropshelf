import { exports } from 'cloudflare:workers';
import { beforeAll, expect, it } from 'vitest';
import { prepareDatabase } from './database';

beforeAll(prepareDatabase);

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

it('rejects oversized JSON MCP requests before storing a file', async () => {
  const uploaded = await rpc('tools/call', { name: 'upload_file', arguments: {
    path: 'over-inline-limit.json', contentType: 'application/json',
    content: JSON.stringify('A'.repeat(5 * 1024 * 1024)),
  } });
  expect(uploaded.response.status).toBe(413);
  expect(uploaded.result.error.message).toContain('Payload Too Large');
  const listed = await rpc('tools/call', { name: 'list_files', arguments: { q: 'over-inline-limit.json' } });
  expect(JSON.parse(listed.result.result.content[0].text).files).toEqual([]);
});

it('supports Trash, restore, and confirmed permanent deletion through MCP', async () => {
  const tools = await rpc('tools/list');
  for (const name of ['trash_file', 'delete_file_permanently']) {
    expect(tools.result.result.tools.find((tool: { name: string }) => tool.name === name).annotations.destructiveHint).toBe(true);
  }
  const uploaded = await rpc('tools/call', { name: 'upload_file', arguments: { path: 'trash-agent.html', content: '<h1>Trash test</h1>' } });
  const file = JSON.parse(uploaded.result.result.content[0].text);
  const activeDelete = await rpc('tools/call', { name: 'delete_file_permanently', arguments: { id: file.id, confirm: true } });
  expect(activeDelete.result.result.isError).toBe(true);
  const trashed = await rpc('tools/call', { name: 'trash_file', arguments: { id: file.id } });
  expect(JSON.parse(trashed.result.result.content[0].text).trashedBy).toBe('developer@example.test');
  expect((await exports.default.fetch(file.url)).status).toBe(404);
  const trash = await rpc('tools/call', { name: 'list_files', arguments: { view: 'trash' } });
  expect(JSON.parse(trash.result.result.content[0].text).files.some((item: { id: string }) => item.id === file.id)).toBe(true);
  const restored = await rpc('tools/call', { name: 'restore_file', arguments: { id: file.id } });
  expect(JSON.parse(restored.result.result.content[0].text).url).toBe(file.url);
  expect((await exports.default.fetch(file.url)).status).toBe(200);
  await rpc('tools/call', { name: 'trash_file', arguments: { id: file.id } });
  const unconfirmed = await rpc('tools/call', { name: 'delete_file_permanently', arguments: { id: file.id } });
  expect(unconfirmed.result.result?.isError ?? Boolean(unconfirmed.result.error)).toBe(true);
  const deleted = await rpc('tools/call', { name: 'delete_file_permanently', arguments: { id: file.id, confirm: true } });
  expect(JSON.parse(deleted.result.result.content[0].text)).toEqual({ id: file.id, deleted: true });
  expect((await exports.default.fetch(file.url)).status).toBe(404);
});

it('supports PDF search, author facets, and confirmed bulk actions through MCP', async () => {
  const tools = await rpc('tools/list');
  for (const name of ['get_file_filters', 'trash_files', 'restore_files', 'delete_files_permanently']) {
    expect(tools.result.result.tools.some((tool: { name: string }) => tool.name === name)).toBe(true);
  }
  const uploaded = await rpc('tools/call', { name: 'upload_file', arguments: {
    path: 'mcp-bulk.pdf', encoding: 'base64', content: btoa('%PDF-1.4\nSample'),
  } });
  expect(uploaded.result.result.isError).not.toBe(true);
  const file = JSON.parse(uploaded.result.result.content[0].text);
  const filters = await rpc('tools/call', { name: 'get_file_filters', arguments: {} });
  const author = JSON.parse(filters.result.result.content[0].text).authors.find((item: { label: string }) => item.label === 'developer@example.test');
  const search = await rpc('tools/call', { name: 'list_files', arguments: { q: 'mcp-bulk', type: 'application/pdf', author: author.value } });
  expect(JSON.parse(search.result.result.content[0].text).files.map((item: { id: string }) => item.id)).toEqual([file.id]);
  const moved = await rpc('tools/call', { name: 'trash_files', arguments: { ids: [file.id] } });
  expect(JSON.parse(moved.result.result.content[0].text).results[0].ok).toBe(true);
  const unconfirmed = await rpc('tools/call', { name: 'delete_files_permanently', arguments: { ids: [file.id] } });
  expect(unconfirmed.result.result?.isError ?? Boolean(unconfirmed.result.error)).toBe(true);
  expect((await exports.default.fetch(file.url)).status).toBe(404);
  const restored = await rpc('tools/call', { name: 'restore_files', arguments: { ids: [file.id] } });
  expect(JSON.parse(restored.result.result.content[0].text).results[0].ok).toBe(true);
  expect((await exports.default.fetch(file.url)).status).toBe(200);
});

it('sorts MCP results by name across pages and rejects a changed sort order', async () => {
  for (const path of ['sort-check-zulu.html', 'sort-check-alpha.html']) {
    await rpc('tools/call', { name: 'upload_file', arguments: { path, content: '<h1>Sort check</h1>' } });
  }
  const args = { q: 'sort-check', sort: 'name', limit: 1 };
  const first = await rpc('tools/call', { name: 'list_files', arguments: args });
  expect(first.result.result.isError).not.toBe(true);
  const page = JSON.parse(first.result.result.content[0].text);
  expect(page.files[0].name).toBe('sort-check-alpha.html');
  const second = await rpc('tools/call', { name: 'list_files', arguments: { ...args, cursor: page.nextCursor } });
  expect(JSON.parse(second.result.result.content[0].text).files[0].name).toBe('sort-check-zulu.html');
  const changed = await rpc('tools/call', { name: 'list_files', arguments: { ...args, sort: 'oldest', cursor: page.nextCursor } });
  expect(changed.result.result.isError).toBe(true);
});

it('reports path conflicts and replaces only the confirmed file version through MCP', async () => {
  const path = 'mcp-replacement/page.html';
  const call = async (name: string, args: unknown) => (await rpc('tools/call', { name, arguments: args })).result.result;
  const uploaded = await call('upload_file', { path, content: 'Original' });
  const file = JSON.parse(uploaded.content[0].text);
  const checked = await call('check_uploads', { paths: [path] });
  expect(JSON.parse(checked.content[0].text)[0]).toMatchObject({ existing: { id: file.id, version: 1 } });
  const refused = await call('upload_file', { path, content: 'Unconfirmed' });
  expect(refused.isError).toBe(true);
  expect(JSON.parse(refused.content[0].text)).toMatchObject({ status: 409, conflict: { id: file.id, version: 1 } });
  const replaced = await call('upload_file', { path, content: 'Confirmed', replace: { id: file.id, version: 1 } });
  expect(replaced.isError).not.toBe(true);
  expect(JSON.parse(replaced.content[0].text)).toMatchObject({ id: file.id, url: file.url, version: 2 });
  expect(await (await exports.default.fetch(file.url)).text()).toBe('Confirmed');
  const stale = await call('upload_file', { path, content: 'Old confirmation', replace: { id: file.id, version: 1 } });
  expect(stale.isError).toBe(true);
  expect(JSON.parse(stale.content[0].text)).toMatchObject({ status: 409, conflict: { version: 2 } });
});
