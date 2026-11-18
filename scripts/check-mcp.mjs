import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFile } from 'node:fs/promises';

const endpoint = process.argv[2];
if (!endpoint || !endpoint.startsWith('https://')) {
  console.error('Usage: node scripts/check-mcp.mjs https://YOUR_APP_HOST/mcp [--write] [--transfer]');
  process.exit(1);
}
const target = new URL(endpoint);
const write = process.argv.includes('--write');
const transfer = process.argv.includes('--transfer');
const callback = 'http://127.0.0.1:8990/callback';
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(24).toString('base64url');

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Request failed with HTTP ${response.status} at ${new URL(url).pathname}.`);
  return response.json();
}
const challenge = await fetch(target, { headers: { Accept: 'application/json' } });
assert.equal(challenge.status, 401, 'The MCP endpoint must require authentication.');
const metadataUrl = challenge.headers.get('WWW-Authenticate')?.match(/resource_metadata="([^"]+)"/)?.[1];
assert.ok(metadataUrl, 'Access must advertise OAuth resource metadata.');
const resource = await getJson(metadataUrl);
const issuer = resource.authorization_servers?.[0];
assert.ok(issuer, 'Access must advertise an authorization server.');
const metadata = await getJson(`${issuer}/.well-known/oauth-authorization-server`);
for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
  assert.equal(new URL(metadata[field]).origin, new URL(issuer).origin, 'OAuth endpoints must use the expected issuer.');
}
const registration = await getJson(metadata.registration_endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'Drop Shelf deployment check', redirect_uris: [callback],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
});
assert.ok(registration.client_id, 'Dynamic client registration must return a client ID.');

let finishLogin;
let rejectLogin;
const login = new Promise((resolve, reject) => { finishLogin = resolve; rejectLogin = reject; });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', callback);
  if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
  if (url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid OAuth state.'); return; }
  const code = url.searchParams.get('code');
  if (!code) { response.writeHead(400).end('Authorization did not complete.'); rejectLogin(new Error('OAuth did not return a code.')); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'no-store' });
  response.end('<!doctype html><title>MCP login complete</title><h1>MCP login complete</h1><p>You can close this tab.</p>');
  finishLogin(code);
});
await new Promise(resolve => { server.listen(8990, '127.0.0.1', resolve); });
const timeout = setTimeout(() => { rejectLogin(new Error('OAuth login timed out.')); }, 10 * 60 * 1000);
const authorize = new URL(metadata.authorization_endpoint);
authorize.search = new URLSearchParams({ response_type: 'code', client_id: registration.client_id,
  redirect_uri: callback, resource: resource.resource, state,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
console.log('Open this URL in your browser to sign in:');
console.log(authorize.href);

let client;
try {
  const code = await login;
  const tokens = await getJson(metadata.token_endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registration.client_id,
      redirect_uri: callback, code_verifier: verifier, code, resource: resource.resource }) });
  assert.ok(tokens.access_token, 'OAuth must return an access token.');
  // Tokens stay in memory. Never print or save them.
  let accessToken = tokens.access_token;
  if (tokens.refresh_token) {
    const refreshed = await getJson(metadata.token_endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: registration.client_id,
        refresh_token: tokens.refresh_token, resource: resource.resource }) });
    assert.ok(refreshed.access_token, 'Refresh must return an access token.');
    accessToken = refreshed.access_token;
    console.log('PASS: OAuth authorization and token refresh.');
  } else console.log('PASS: OAuth authorization. The server did not return a refresh token.');
  const transport = new StreamableHTTPClientTransport(target, {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  client = new Client({ name: 'dropshelf-deployment-check', version: '0.1.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  for (const name of ['upload_file', 'check_uploads', 'trash_file', 'restore_file', 'delete_file_permanently', 'get_file_filters', 'trash_files', 'restore_files', 'delete_files_permanently']) {
    assert.ok(tools.tools.some(tool => tool.name === name), `The server must expose ${name}.`);
  }
  async function call(name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name} must succeed.`);
    const text = result.content.find(item => item.type === 'text')?.text;
    assert.ok(text, `${name} must return a JSON record.`);
    return JSON.parse(text);
  }
  const identity = await call('whoami');
  assert.equal(identity.kind, 'user');
  assert.ok(identity.email, 'A human login must have a verified email.');
  const page = await call('list_files', { limit: 2 });
  assert.ok(Array.isArray(page.files));
  const trash = await call('list_files', { view: 'trash', limit: 2 });
  assert.ok(Array.isArray(trash.files));
  assert.ok(trash.files.every(file => file.trashedAt !== null));
  const filters = await call('get_file_filters');
  assert.ok(Array.isArray(filters.authors) && Array.isArray(filters.types));
  const search = await call('list_files', { q: 'no-such-deployment-check-file', type: 'application/pdf' });
  assert.equal(search.total, 0);
  console.log('PASS: MCP SDK connection, tool discovery, verified identity, file listing, search, and filters.');
  if (transfer) {
    const config = await getJson(`${target.origin}/api/config`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const path = `transfer-check-${randomBytes(8).toString('hex')}.json`;
    const bytes = Buffer.from(JSON.stringify({ nonce: randomBytes(64).toString('hex') }) + '\r\n');
    const [checked] = await call('check_uploads', { paths: [path] });
    assert.ok(checked.path === path && !checked.existing && !checked.error, 'The test path must be free.');
    const upload = await call('create_upload', { path, sizeBytes: bytes.length, contentType: 'application/json' });
    const uploadUrl = new URL(upload.uploadUrl);
    assert.equal(uploadUrl.origin, config.contentOrigin);
    assert.ok(uploadUrl.pathname.startsWith('/transfer/') && upload.method === 'PUT');
    assert.deepEqual(upload.headers, { 'Content-Type': 'application/json' });
    const withoutCookies = { credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(30_000) };
    const put = { ...withoutCookies, method: 'PUT', headers: upload.headers, body: bytes };
    const uploaded = await fetch(uploadUrl, put);
    assert.equal(uploaded.status, 201, 'The signed PUT must work with the URL alone.');
    const file = await uploaded.json();
    const replayedUpload = await fetch(uploadUrl, put);
    assert.equal(replayedUpload.status, 403, 'The upload link must reject reuse.');
    await replayedUpload.body?.cancel();

    const record = await call('get_file', { id: file.id });
    assert.ok(record.path === path && record.size === bytes.length && record.source === 'mcp');
    assert.equal(record.uploaderEmail, identity.email);
    const download = await call('get_download_link', { id: file.id });
    const downloadUrl = new URL(download.downloadUrl);
    assert.equal(downloadUrl.origin, config.contentOrigin);
    assert.ok(downloadUrl.pathname.startsWith('/transfer/') && download.method === 'GET');
    const downloaded = await fetch(downloadUrl, withoutCookies);
    assert.equal(downloaded.status, 200, 'The signed GET must work with the URL alone.');
    assert.equal(downloaded.headers.get('Content-Type'), 'application/json');
    assert.match(downloaded.headers.get('Content-Disposition'), /^attachment;/);
    const originalHash = createHash('sha256').update(bytes).digest('hex');
    const downloadedHash = createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex');
    assert.equal(downloadedHash, originalHash, 'The downloaded bytes must match the original.');
    const replayedDownload = await fetch(downloadUrl, withoutCookies);
    assert.equal(replayedDownload.status, 403, 'The download link must reject reuse.');
    await replayedDownload.body?.cancel();
    const browserDownload = await fetch(download.browserDownloadUrl, { ...withoutCookies, headers: { Accept: 'application/json' } });
    assert.equal(browserDownload.status, 401, 'The normal content URL must still require Access.');
    await browserDownload.body?.cancel();
    console.log('PASS: Single-use upload and download without cookies or Access headers. SHA-256 matches.');
    console.log(JSON.stringify({ path, size: record.size, sha256: downloadedHash,
      put: uploaded.status, get: downloaded.status, replayPut: replayedUpload.status, replayGet: replayedDownload.status,
      protectedDownload: browserDownload.status }));
  }
  if (write) {
    const { uploadId } = await call('create_upload');
    const folder = `mcp-check-${uploadId}`;
    const html = await readFile(new URL('../tests/fixtures/site/index.html', import.meta.url), 'utf8');
    const svg = await readFile(new URL('../tests/fixtures/site/images/sample.svg', import.meta.url), 'utf8');
    const markdown = await readFile(new URL('../tests/fixtures/site/notes.md', import.meta.url), 'utf8');
    const file = await call('upload_file', { uploadId, path: `${folder}/index.html`, content: html });
    const image = await call('upload_file', { uploadId, path: `${folder}/images/sample.svg`, content: svg });
    const notes = await call('upload_file', { uploadId, path: `${folder}/notes.md`, content: markdown });
    const [checked] = await call('check_uploads', { paths: [file.path] });
    assert.equal(checked.existing.id, file.id);
    assert.equal(checked.existing.version, 1);
    assert.equal(file.uploaderEmail, identity.email);
    assert.equal(file.source, 'mcp');
    const content = await fetch(file.url, { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(content.status, 200);
    assert.equal(await content.text(), html);
    assert.equal(new URL('images/sample.svg', file.url).href, image.url);
    const imageView = await fetch(image.url, { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(await imageView.text(), svg);
    const notesView = await fetch(notes.url, { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(notesView.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    assert.equal(await notesView.text(), markdown);
    const rawHeaders = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const group = await getJson(`${target.origin}/api/uploads`, { method: 'POST', headers: rawHeaders, body: '{}' });
    const csv = 'name,status\nOAuth,verified\n';
    const uploaded = await getJson(`${target.origin}/api/uploads/${group.uploadId}?path=${folder}/oauth-check.csv`, {
      method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/csv',
        'Content-Length': String(Buffer.byteLength(csv)) }, body: csv,
    });
    assert.equal(uploaded.uploaderEmail, identity.email);
    const csvView = await fetch(uploaded.url, { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(await csvView.text(), csv);
    console.log('PASS: MCP and HTTP uploads share the verified email; protected HTML, SVG, Markdown, and CSV links work.');
    console.log(JSON.stringify({ samplePageUrl: file.url, markdownUrl: notes.url }));
  }
} finally {
  clearTimeout(timeout);
  if (client) await client.close();
  server.close();
}
