import type { BulkResult, FileFilterOptions, FilePage, Principal, SharedFile, UploadCheck } from '../shared/types';
import { test, expect, fixtureBytes } from './fixtures';
import { zipFixture } from './archive';

interface FolderPage {
  entries: ({ kind: 'folder'; path: string; fileCount: number }
    | ({ kind: 'file' } & Pick<SharedFile, 'id' | 'path' | 'url' | 'downloadUrl'>))[];
  total: number;
  nextCursor: string | null;
}

test('connects with the MCP SDK, discovers tools, and returns the server identity', async ({ mcp }) => {
  expect(mcp.client.getServerVersion()?.name).toBe('dropshelf');
  const { tools } = await mcp.client.listTools();
  expect(tools.map(tool => tool.name).sort()).toEqual([
    'check_uploads', 'create_upload', 'delete_file_permanently', 'delete_files_permanently', 'get_download_link',
    'get_file', 'get_file_filters', 'list_files', 'list_folder', 'restore_file', 'restore_files', 'submit_feedback', 'trash_file', 'trash_files',
    'upload_file', 'upload_file_reference', 'whoami',
  ]);
  for (const name of ['trash_file', 'delete_file_permanently', 'upload_file']) {
    expect(tools.find(tool => tool.name === name)?.annotations?.destructiveHint).toBe(true);
  }
  expect(tools.find(tool => tool.name === 'submit_feedback')?.annotations).toMatchObject({
    readOnlyHint: false, openWorldHint: true, idempotentHint: false,
  });
  expect(await mcp.call<Principal>('whoami')).toEqual({
    id: 'local-developer', email: 'e2e@example.test', label: 'e2e@example.test', kind: 'user',
  });
});

test('lists and paginates direct subfolders and recursive files through MCP', async ({ mcp }) => {
  for (const path of ['audit/project/2026-11-18T1800Z/view.html', 'audit/project/2026-11-17T1800Z/snapshot/data.json',
    'audit/project/2026-11-17T1800Z/report.json', 'audit/project-other/2026-11-16T1800Z/data.json']) {
    await mcp.call('upload_file', { path, content: '{}' });
  }
  const query = { folder: 'audit/project/', sort: 'name', limit: 1 };
  const first = await mcp.call<FolderPage>('list_folder', query);
  expect(first.entries).toMatchObject([{ kind: 'folder', path: 'audit/project/2026-11-17T1800Z', fileCount: 2 }]);
  expect(first.total).toBe(2);
  expect(first.nextCursor).toBeTruthy();
  const next = await mcp.call<FolderPage>('list_folder', { ...query, cursor: first.nextCursor });
  expect(next.entries).toMatchObject([{ kind: 'folder', path: 'audit/project/2026-11-18T1800Z', fileCount: 1 }]);
  expect(next.nextCursor).toBeNull();
  const folder = 'audit/project/2026-11-17T1800Z';
  const direct = await mcp.call<FolderPage>('list_folder', { folder });
  expect(direct.entries).toMatchObject([
    { kind: 'folder', path: folder + '/snapshot' },
    { kind: 'file', path: folder + '/report.json', id: expect.any(String), url: expect.stringContaining('/f/') },
  ]);
  const files = await mcp.call<FolderPage>('list_folder', { folder, recursive: true });
  expect(files.entries).toMatchObject([
    { kind: 'file', path: folder + '/snapshot/data.json' },
    { kind: 'file', path: folder + '/report.json' },
  ]);
  const changed = await mcp.client.callTool({ name: 'list_folder', arguments: { ...query, recursive: true, cursor: first.nextCursor } });
  expect(changed.isError).toBe(true);
});

test('validates feedback and reports when the instance has no Slack credentials', async ({ mcp }) => {
  const report = { summary: 'Test report', details: 'The sample tool failed.', proposedFix: 'Update the tool.' };
  const result = await mcp.client.callTool({ name: 'submit_feedback', arguments: report });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({
    error: "Slack feedback is unavailable. SLACK_BOT_TOKEN is missing. SLACK_CHANNEL_ID is missing. Set a non-empty value for each listed secret on this instance's Cloudflare app Worker.",
    status: 503,
  }) }]);
  for (const args of [{ ...report, proposedFix: ' ' }, { ...report, channel: 'C222' }]) {
    const invalid = await mcp.client.callTool({ name: 'submit_feedback', arguments: args });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).not.toContain('Slack feedback is unavailable');
  }
});

test('uploads a folder and binary ZIP, then serves the original bytes over HTTP', async ({ mcp, shelf, app }) => {
  const { uploadId, uploadUrl } = await mcp.call<{ uploadId: string; uploadUrl: string }>('create_upload');
  expect(uploadUrl).toBe(`${app.appOrigin}/api/uploads/${uploadId}`);
  const html = await fixtureBytes('site/index.html');
  const file = await mcp.call<SharedFile>('upload_file', { uploadId, path: 'sdk-site/index.html', content: html.toString() });
  const uploaded = [file];
  expect(file).toMatchObject({ source: 'mcp', uploaderEmail: 'e2e@example.test', version: 1, uploadId });
  expect(await (await shelf.http.get(file.url)).body()).toEqual(html);
  for (const path of ['images/sample.svg', 'styles/site.css', 'scripts/site.js', 'nested/notes.md']) {
    const bytes = await fixtureBytes(`site/${path}`);
    const encoding = path.endsWith('.svg') ? 'base64' : 'utf8';
    const asset = await mcp.call<SharedFile>('upload_file', {
      uploadId, path: `sdk-site/${path}`, content: bytes.toString(encoding), encoding,
    });
    expect(new URL(path, file.url).href).toBe(asset.url);
    expect(await (await shelf.http.get(asset.url)).body()).toEqual(bytes);
    uploaded.push(asset);
  }
  const zip = await zipFixture();
  const archive = await mcp.call<SharedFile>('upload_file', {
    path: 'sdk-bundle.zip', content: zip.toString('base64'), encoding: 'base64',
  });
  expect(archive.contentType).toBe('application/zip');
  const response = await shelf.http.get(archive.downloadUrl);
  expect(response.headers()['content-disposition']).toContain('attachment');
  expect(await response.body()).toEqual(zip);
  expect((await shelf.files()).map(item => item.id).sort()).toEqual([...uploaded, archive].map(item => item.id).sort());
});

test('uploads JSON through MCP and retrieves its metadata and original bytes', async ({ mcp, shelf }) => {
  const { tools } = await mcp.client.listTools();
  expect(tools.find(tool => tool.name === 'upload_file')?.description).toContain('JSON');
  const bytes = await fixtureBytes('data.json');
  const uploaded: SharedFile[] = [];
  for (const encoding of ['utf8', 'base64'] as const) {
    const file = await mcp.call<SharedFile>('upload_file', {
      path: `json/${encoding}.json`, content: bytes.toString(encoding), encoding,
      ...(encoding === 'utf8' && { contentType: 'application/json' }),
    });
    expect(file).toMatchObject({ source: 'mcp', contentType: 'application/json', size: bytes.length });
    expect(await mcp.call<SharedFile>('get_file', { id: file.id })).toEqual(file);
    for (const [url, disposition] of [[file.url, 'inline'], [file.downloadUrl, 'attachment']]) {
      const response = await shelf.http.get(url!);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toBe('application/json');
      expect(response.headers()['content-disposition']).toContain(disposition);
      expect(await response.body()).toEqual(bytes);
    }
    uploaded.push(file);
  }
  const filters = await mcp.call<FileFilterOptions>('get_file_filters');
  expect(filters.types).toContainEqual({ value: 'application/json', label: 'JSON', count: 2 });
  const listed = await mcp.call<FilePage>('list_files', { type: 'application/json' });
  expect(listed.files.map(file => file.id).sort()).toEqual(uploaded.map(file => file.id).sort());
});

test('requires the current file version for replacement and keeps the shared URL', async ({ mcp, shelf, seed }) => {
  const [checked] = await mcp.call<UploadCheck[]>('check_uploads', { paths: [seed.alpha.path] });
  expect(checked?.existing).toMatchObject({ id: seed.alpha.id, version: 1 });
  const rejected = await mcp.client.callTool({ name: 'upload_file', arguments: { path: seed.alpha.path, content: '# Not approved' } });
  expect(rejected.isError).toBe(true);
  expect(await (await shelf.http.get(seed.alpha.url)).body()).toEqual(await fixtureBytes('note.md'));
  const content = (await fixtureBytes('replacement.md')).toString();
  const replacement = { id: seed.alpha.id, version: checked!.existing!.version };
  const updated = await mcp.call<SharedFile>('upload_file', { path: seed.alpha.path, content, replace: replacement });
  expect(updated).toMatchObject({ id: seed.alpha.id, url: seed.alpha.url, version: 2, source: 'mcp' });
  const stale = await mcp.client.callTool({ name: 'upload_file', arguments: { path: seed.alpha.path, content: '# Stale version', replace: replacement } });
  expect(stale.isError).toBe(true);
  expect(await (await shelf.http.get(seed.alpha.url)).text()).toBe(content);
  expect(await mcp.call<SharedFile>('get_file', { id: seed.alpha.id })).toMatchObject({ version: 2, url: seed.alpha.url });
});

test('paginates sorted results and applies file type and author filters', async ({ mcp, seed }) => {
  for (const name of ['zulu', 'alpha']) {
    await mcp.call<SharedFile>('upload_file', { path: `sdk-order-${name}.md`, content: `# ${name}` });
  }
  const query = { q: 'sdk-order', sort: 'name', limit: 1 };
  const first = await mcp.call<FilePage>('list_files', query);
  expect(first.files.map(file => file.name)).toEqual(['sdk-order-alpha.md']);
  expect(first.total).toBe(2);
  expect(first.nextCursor).toBeTruthy();
  const second = await mcp.call<FilePage>('list_files', { ...query, cursor: first.nextCursor });
  expect(second.files.map(file => file.name)).toEqual(['sdk-order-zulu.md']);
  expect(second.nextCursor).toBeNull();
  const changed = await mcp.client.callTool({ name: 'list_files', arguments: { ...query, sort: 'oldest', cursor: first.nextCursor } });
  expect(changed.isError).toBe(true);
  const filters = await mcp.call<FileFilterOptions>('get_file_filters');
  const author = filters.authors.find(item => item.label === 'e2e@example.test');
  expect(author).toBeDefined();
  const filtered = await mcp.call<FilePage>('list_files', { type: 'text/csv', author: author!.value });
  expect(filtered.files.map(file => file.id)).toEqual([seed.zulu.id]);
});

test('moves files to Trash, restores links, and requires confirmation for permanent deletion', async ({ mcp, shelf, seed }) => {
  const activeDelete = await mcp.client.callTool({ name: 'delete_file_permanently', arguments: { id: seed.alpha.id, confirm: true } });
  expect(activeDelete.isError).toBe(true);
  const ids = [seed.alpha.id, seed.zulu.id];
  const moved = await mcp.call<BulkResult>('trash_files', { ids });
  expect(moved.results).toEqual(ids.map(id => ({ id, ok: true })));
  expect((await shelf.http.get(seed.alpha.url)).status()).toBe(404);
  const trash = await mcp.call<FilePage>('list_files', { view: 'trash' });
  expect(trash.files.map(file => file.id)).toEqual(expect.arrayContaining(ids));
  const unconfirmed = await mcp.client.callTool({ name: 'delete_files_permanently', arguments: { ids } });
  expect(unconfirmed.isError).toBe(true);
  const restored = await mcp.call<BulkResult>('restore_files', { ids });
  expect(restored.results.every(item => item.ok)).toBe(true);
  expect(await (await shelf.http.get(seed.alpha.url)).body()).toEqual(await fixtureBytes('note.md'));
  await mcp.call<SharedFile>('trash_file', { id: seed.alpha.id });
  const file = await mcp.call<SharedFile>('restore_file', { id: seed.alpha.id });
  expect(file.url).toBe(seed.alpha.url);
  await mcp.call<SharedFile>('trash_file', { id: seed.alpha.id });
  expect(await mcp.call('delete_file_permanently', { id: seed.alpha.id, confirm: true })).toEqual({ id: seed.alpha.id, deleted: true });
  expect((await shelf.http.get(seed.alpha.url)).status()).toBe(404);
  expect((await shelf.http.get(`/api/files/${seed.alpha.id}`)).status()).toBe(404);
});

test('rejects invalid uploads and cross-origin mutations without changing the shelf', async ({ mcp, shelf, app }) => {
  for (const args of [
    { path: '../outside.md', content: '# Invalid path' },
    { path: 'program.exe', content: 'unsupported' },
    { path: 'invalid.zip', content: '!not-base64!', encoding: 'base64' },
    { path: 'too-large.md', content: 'A'.repeat(app.config.maxFileBytes + 1) },
    { path: 'too-large.json', content: JSON.stringify('A'.repeat(app.config.maxFileBytes)), contentType: 'application/json' },
  ]) {
    const result = await mcp.client.callTool({ name: 'upload_file', arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
  }
  const foreign = { Origin: 'https://untrusted.example.test' };
  expect((await shelf.http.post('/api/uploads', { headers: foreign, data: {} })).status()).toBe(403);
  expect((await shelf.http.post('/mcp', { headers: foreign, data: {} })).status()).toBe(403);
  expect((await shelf.http.get(`${app.contentOrigin}/api/files`)).status()).toBe(404);
  const forged = await shelf.http.post('/api/uploads', { data: { uploaderEmail: 'someone-else@example.test' } });
  expect(forged.status()).toBe(400);
  expect(await shelf.files()).toEqual([]);
});

test('transfers the original bytes with single-use HTTP links and no cookies', async ({ app, mcp }) => {
  const path = 'http-bridge.json';
  const bytes = await fixtureBytes('data.json');
  const upload = await mcp.call<{ uploadId: string; uploadUrl: string; headers: Record<string, string>; maxFileBytes: number; method: string }>(
    'create_upload', { path, sizeBytes: bytes.byteLength });
  expect(upload.maxFileBytes).toBe(app.config.maxFileBytes);
  expect(upload.method).toBe('PUT');
  expect(new URL(upload.uploadUrl).origin).toBe(app.contentOrigin);
  expect(upload.headers).toEqual({ 'Content-Type': 'application/json' });
  const noCookies = { credentials: 'omit', redirect: 'error' } as const;
  const wrongMethod = await fetch(upload.uploadUrl, noCookies);
  expect(wrongMethod.status).toBe(405);
  await wrongMethod.body?.cancel();

  const send = () => fetch(upload.uploadUrl, { ...noCookies, method: upload.method, headers: upload.headers, body: bytes });
  const results = await Promise.all([send(), send()]);
  expect(results.map(response => response.status).sort()).toEqual([201, 403]);
  await results.find(response => response.status === 403)!.body?.cancel();
  const response = results.find(result => result.status === 201)!;
  const file = await response.json() as SharedFile;
  expect(await mcp.call<SharedFile>('get_file', { id: file.id })).toMatchObject({
    uploadId: upload.uploadId, path, source: 'mcp', uploaderEmail: 'e2e@example.test',
  });
  const downloaded = await mcp.call<{ downloadUrl: string; method: string }>('get_download_link', { id: file.id });
  expect(downloaded.method).toBe('GET');
  expect(new URL(downloaded.downloadUrl).origin).toBe(app.contentOrigin);
  const attachment = await fetch(downloaded.downloadUrl, noCookies);
  expect(attachment.status).toBe(200);
  expect(attachment.headers.get('content-disposition')).toMatch(/^attachment;/);
  expect(Buffer.from(await attachment.arrayBuffer())).toEqual(bytes);
  const used = await fetch(downloaded.downloadUrl, noCookies);
  expect(used.status).toBe(403);
  await used.body?.cancel();
});

test('uploads a 160-file run with one MCP batch link and keeps the original text and XML bytes', async ({ app, mcp }) => {
  const folder = 'batch-audit/run';
  const samples = [
    { path: 'robots.txt', contentType: 'text/plain', bytes: Buffer.from('User-agent: *\r\n') },
    { path: 'snapshot/sitemap.xml', contentType: 'text/xml', bytes: Buffer.from('<?xml version="1.0"?><urlset/>\r\n') },
    ...Array.from({ length: 158 }, (_, index) => ({
      path: `snapshot/record-${index}.json`, contentType: 'application/json', bytes: Buffer.from(JSON.stringify({ index })),
    })),
  ];
  const batch = await mcp.call<{ folder: string; uploadId: string; uploadUrl: string; method: string; headers: Record<string, string> }>(
    'create_upload', { folder });
  expect(batch.folder).toBe(folder);
  expect(new URL(batch.uploadUrl).origin).toBe(app.contentOrigin);
  expect(batch.method).toBe('POST');
  const direct = { credentials: 'omit', redirect: 'error' } as const;
  const manifest = { ...direct, method: batch.method, headers: batch.headers,
    body: JSON.stringify({ files: samples.map(({ path, contentType, bytes }) => ({ path, contentType, sizeBytes: bytes.length })) }) };
  const response = await fetch(batch.uploadUrl, manifest);
  expect(response.status).toBe(200);
  const issued = await response.json() as {
    uploadId: string; method: string; files: { path: string; uploadUrl: string; headers: Record<string, string> }[];
  };
  expect(issued.uploadId).toBe(batch.uploadId);
  expect(issued.method).toBe('PUT');
  expect(issued.files.map(file => file.path)).toEqual(samples.map(file => file.path));
  const put = (index: number) => fetch(issued.files[index]!.uploadUrl, {
    ...direct, method: issued.method, headers: issued.files[index]!.headers, body: samples[index]!.bytes,
  });
  const uploaded: SharedFile[] = [];
  for (let start = 0; start < samples.length; start += 8) {
    const responses = await Promise.all(issued.files.slice(start, start + 8).map((_, offset) => put(start + offset)));
    for (const item of responses) {
      expect(item.status).toBe(201);
      uploaded.push(await item.json() as SharedFile);
    }
  }
  expect(uploaded.every(file => file.uploadId === batch.uploadId && file.path.startsWith(folder + '/'))).toBe(true);
  for (const [index, type] of ['text/plain', 'application/xml'].entries()) {
    const { downloadUrl } = await mcp.call<{ downloadUrl: string }>('get_download_link', { id: uploaded[index]!.id });
    const attachment = await fetch(downloadUrl, direct);
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get('Content-Type')).toBe(type);
    expect(Buffer.from(await attachment.arrayBuffer())).toEqual(samples[index]!.bytes);
  }
  const first = await mcp.call<FolderPage>('list_folder', { folder, recursive: true, limit: 100 });
  expect(first.total).toBe(160);
  const second = await mcp.call<FolderPage>('list_folder', { folder, recursive: true, limit: 100, cursor: first.nextCursor });
  expect(new Set([...first.entries, ...second.entries].map(entry => entry.path)).size).toBe(160);
  expect(second.nextCursor).toBeNull();
  for (const replay of [await fetch(batch.uploadUrl, manifest), await put(0)]) {
    expect(replay.status).toBe(403);
    await replay.body?.cancel();
  }
});
