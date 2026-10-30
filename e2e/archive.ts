import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js/lib/zip-core-native.js';
import type { Download } from '@playwright/test';

const codecs = { useWebWorkers: false, useCompressionStream: true };

export async function zipFixture(): Promise<Buffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), codecs);
  await writer.add('note.md', new TextReader('# A file inside the ZIP\n'), { lastModDate: new Date('2026-01-01T00:00:00Z') });
  return Buffer.from(await writer.close());
}

export async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error(`The download failed: ${await download.failure()}`);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function unzip(bytes: Buffer): Promise<Record<string, Buffer>> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), codecs);
  const files: Record<string, Buffer> = {};
  try {
    for (const entry of await reader.getEntries()) {
      if (!entry.directory) files[entry.filename] = Buffer.from(await entry.getData(new Uint8ArrayWriter(), { checkSignature: true }));
    }
    return files;
  } finally { await reader.close(); }
}
