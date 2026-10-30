import { test as base, expect, request, type APIRequestContext } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BulkResult, FilePage, SharedFile } from '../shared/types';
import { startLocalApp, type LocalApp } from './local-server';

export const fixturePath = (path: string) => fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url));
export const fixtureBytes = (path: string) => readFile(fixturePath(path));

export class ShelfFixture {
  constructor(readonly http: APIRequestContext) {}

  async upload(path: string, bytes: Buffer, contentType = 'text/markdown', uploadId?: string): Promise<SharedFile> {
    if (!uploadId) {
      const started = await this.http.post('/api/uploads', { data: {} });
      expect(started.status(), await started.text()).toBe(201);
      uploadId = (await started.json()).uploadId;
    }
    const response = await this.http.put(`/api/uploads/${uploadId}?${new URLSearchParams({ path })}`, {
      headers: { 'Content-Type': contentType }, data: bytes,
    });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  }

  async files(view = 'files'): Promise<SharedFile[]> {
    const files: SharedFile[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ view, limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const response = await this.http.get(`/api/files?${params}`);
      expect(response.ok(), await response.text()).toBeTruthy();
      const page = await response.json() as FilePage;
      files.push(...page.files);
      cursor = page.nextCursor;
    } while (cursor);
    return files;
  }

  async bulk(action: 'trash' | 'delete', files: SharedFile[]): Promise<void> {
    for (let index = 0; index < files.length; index += 10) {
      const response = await this.http.post('/api/files/bulk', {
        data: { action, ids: files.slice(index, index + 10).map(file => file.id), ...(action === 'delete' && { confirm: true }) },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      const result = await response.json() as BulkResult;
      expect(result.results.every(item => item.ok), JSON.stringify(result)).toBeTruthy();
    }
  }

  async reset(): Promise<void> {
    await this.bulk('trash', await this.files());
    await this.bulk('delete', await this.files('trash'));
    expect(await this.files()).toEqual([]);
    expect(await this.files('trash')).toEqual([]);
  }
}

export interface SeedFiles {
  alpha: SharedFile;
  zulu: SharedFile;
  page: SharedFile;
  trashed: SharedFile;
}

async function seed(shelf: ShelfFixture): Promise<SeedFiles> {
  const alpha = await shelf.upload('alpha.md', await fixtureBytes('note.md'));
  const zulu = await shelf.upload('zulu.csv', await fixtureBytes('data.csv'), 'text/csv');
  const page = await shelf.upload('site/index.html', await fixtureBytes('site/index.html'), 'text/html');
  for (const [path, type] of [
    ['styles/site.css', 'text/css'], ['scripts/site.js', 'text/javascript'],
    ['images/sample.svg', 'image/svg+xml'], ['nested/notes.md', 'text/markdown'],
  ] as const) {
    await shelf.upload(`site/${path}`, await fixtureBytes(`site/${path}`), type, page.uploadId);
  }
  const discarded = await shelf.upload('discarded.md', Buffer.from('# Discarded fixture\n'));
  const moved = await shelf.http.post(`/api/files/${discarded.id}/trash`, { data: {} });
  expect(moved.status(), await moved.text()).toBe(200);
  const trashed = await moved.json() as SharedFile;
  expect(trashed.trashedAt).not.toBeNull();
  return { alpha, zulu, page, trashed };
}

export class McpFixture {
  constructor(readonly client: Client) {}
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const content = result.content.find(item => item.type === 'text');
    if (!content || content.type !== 'text') throw new Error(`${name} did not return JSON text.`);
    return JSON.parse(content.text) as T;
  }
}

interface TestFixtures {
  shelf: ShelfFixture;
  seed: SeedFiles;
  mcp: McpFixture;
}

export const test = base.extend<TestFixtures, { app: LocalApp }>({
  app: [async ({}, use) => {
    const app = await startLocalApp();
    try { await use(app); }
    finally { await app.stop(); }
  }, { scope: 'worker', timeout: 60_000 }],
  shelf: [async ({ app }, use, testInfo) => {
    const http = await request.newContext({ baseURL: app.appOrigin });
    const shelf = new ShelfFixture(http);
    try {
      await shelf.reset();
      await use(shelf);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('worker-output', { body: app.logs(), contentType: 'text/plain' });
      }
      await http.dispose();
    }
  }, { auto: true }],
  seed: async ({ shelf }, use) => { await use(await seed(shelf)); },
  page: async ({ page, app }, use) => {
    const errors: string[] = [];
    const outsideRequests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.context().route('**/*', async route => {
      const origin = new URL(route.request().url()).origin;
      if (origin === app.appOrigin || origin === app.contentOrigin) await route.continue();
      else { outsideRequests.push(route.request().url()); await route.abort('blockedbyclient'); }
    });
    try { await use(page); }
    finally {
      expect(errors, 'The app must not raise a browser script error.').toEqual([]);
      expect(outsideRequests, 'Browser tests must use only their own local server.').toEqual([]);
    }
  },
  mcp: async ({ app, shelf }, use) => {
    // Depend on shelf so reset completes before the SDK connects.
    void shelf;
    const client = new Client({ name: 'dropshelf-e2e', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', app.appOrigin)));
      await use(new McpFixture(client));
    } finally { await client.close(); }
  },
});

export { expect } from '@playwright/test';
