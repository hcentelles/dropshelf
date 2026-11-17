import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { prepareDatabase } from './database';

beforeAll(prepareDatabase);
afterEach(() => vi.unstubAllGlobals());

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

it('copies the original bytes by reference and returns only a link and file details for download', async () => {
  const { result: initialized } = await rpc('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'transfer-test', version: '1.0.0' },
  });
  expect(initialized.result.instructions).toContain('For transfer-only requests');
  const { result: listed } = await rpc('tools/list');
  const tool = listed.result.tools.find((item: { name: string }) => item.name === 'upload_file_reference');
  expect(tool._meta['openai/fileParams']).toEqual(['file']);
  expect(tool.inputSchema.properties).not.toHaveProperty('content');
  const fileSchema = tool.inputSchema.properties.file;
  expect(Object.keys(fileSchema.properties).sort()).toEqual(['download_url', 'file_id', 'file_name', 'mime_type']);
  expect([...fileSchema.required].sort()).toEqual(['download_url', 'file_id']);

  const source = 'https://files.oaiusercontent.com/file-original?signature=test';
  const bytes = new TextEncoder().encode('\uFEFF{\r\n  "value": "Original file ✓"\r\n}\r\n');
  const upstream = vi.fn(async () => new Response(bytes, {
    headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', upstream);
  const uploaded = await rpc('tools/call', { name: 'upload_file_reference', arguments: {
    file: { download_url: source, file_id: 'file-original', file_name: 'original.json' },
  } });
  expect(upstream).toHaveBeenCalledExactlyOnceWith(new URL(source), expect.objectContaining({
    redirect: 'manual', headers: { 'Accept-Encoding': 'identity' },
  }));
  expect(uploaded.result.result.isError).not.toBe(true);
  const uploadText = uploaded.result.result.content[0].text;
  expect(uploadText).not.toContain('Original file');
  expect(uploadText).not.toContain('signature=test');
  const file = JSON.parse(uploadText);
  expect(file).toMatchObject({ name: 'original.json', contentType: 'application/json', size: bytes.length, source: 'mcp' });

  const download = await rpc('tools/call', { name: 'get_download_link', arguments: { id: file.id } });
  expect(JSON.parse(download.result.result.content[0].text)).toEqual({
    id: file.id, name: file.name, path: file.path, contentType: 'application/json', size: bytes.length, downloadUrl: file.downloadUrl,
  });
  const downloaded = await exports.default.fetch(file.downloadUrl);
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get('Content-Disposition')).toMatch(/^attachment;/);
  expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  await rpc('tools/call', { name: 'trash_file', arguments: { id: file.id } });
  const trashed = await rpc('tools/call', { name: 'get_download_link', arguments: { id: file.id } });
  expect(trashed.result.result.isError).toBe(true);
  expect(JSON.parse(trashed.result.result.content[0].text)).toMatchObject({ status: 404 });
});

it('rejects untrusted file sources and redirects', async () => {
  const upstream = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://untrusted.example.test/file' } }));
  vi.stubGlobal('fetch', upstream);
  const call = async (url: string) => (await rpc('tools/call', { name: 'upload_file_reference', arguments: {
    file: { download_url: url, file_id: 'file-untrusted', file_name: 'untrusted.json' },
  } })).result.result;

  for (const url of ['https://files.oaiusercontent.com.untrusted.example.test/file', 'https://user@files.oaiusercontent.com/file', 'http://files.oaiusercontent.com/file']) {
    expect(JSON.parse((await call(url)).content[0].text)).toMatchObject({ status: 400 });
  }
  expect(upstream).not.toHaveBeenCalled();
  expect(JSON.parse((await call('https://files.oaiusercontent.com/file')).content[0].text)).toMatchObject({ status: 502 });
  expect(upstream).toHaveBeenCalledTimes(1);
  const listed = await rpc('tools/call', { name: 'list_files', arguments: { q: 'untrusted.json' } });
  expect(JSON.parse(listed.result.result.content[0].text).files).toEqual([]);
});

it('does not publish a reference upload with the wrong length', async () => {
  const oversized = String(Number(env.MAX_FILE_BYTES) + 1);
  const upstream = vi.fn(async () => new Response('{}', { headers: { 'Content-Length': oversized } }));
  vi.stubGlobal('fetch', upstream);
  const call = async () => (await rpc('tools/call', { name: 'upload_file_reference', arguments: {
    file: { download_url: 'https://files.oaiusercontent.com/file', file_id: 'file-length', file_name: 'bad-length.json' },
  } })).result.result;

  expect(JSON.parse((await call()).content[0].text)).toMatchObject({ status: 413 });
  upstream.mockImplementationOnce(async () => new Response('{}', { headers: { 'Content-Length': '100' } }));
  expect((await call()).isError).toBe(true);
  const listed = await rpc('tools/call', { name: 'list_files', arguments: { q: 'bad-length.json' } });
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
