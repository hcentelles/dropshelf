import { ZipWriter } from '@zip.js/zip.js/lib/zip-core-native.js';
import { cleanPath } from './http';
import { shelf } from './shelf-client';

export async function downloadFolder(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const folder = cleanPath(new URL(request.url).searchParams.get('path') ?? '');
  const files = await shelf(env).folderArchiveFiles(folder);
  const name = folder.split('/').at(-1)!;
  const parentLength = folder.length - name.length;
  let output: TransformStreamDefaultController<Uint8Array>;
  const stream = new TransformStream<Uint8Array, Uint8Array>({ start(controller) { output = controller; } });
  const abort = new AbortController();
  const onAbort = () => abort.abort(request.signal.reason);
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  // Propagate browser cancellation to compression and the current R2 read.
  const reader = stream.readable.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    async cancel(reason) { abort.abort(reason); await reader.cancel(reason); },
  });
  const zip = new ZipWriter(stream.writable, {
    useWebWorkers: false, useCompressionStream: true, level: 6,
    bufferedWrite: false, signal: abort.signal,
  });
  ctx.waitUntil((async () => {
    try {
      for (const file of files) {
        abort.signal.throwIfAborted();
        const object = await env.FILES.get(file.object_key);
        if (!object) throw new Error('A stored file is no longer available.');
        await zip.add(file.path.slice(parentLength), object.body, {
          uncompressedSize: file.size, lastModDate: new Date(file.updated_at || file.created_at),
        });
      }
      await zip.close();
    } catch (error) {
      // An incomplete ZIP must fail, not look like a successful partial folder.
      output!.error(error);
      if (!abort.signal.aborted) console.error(JSON.stringify({ event: 'folder_download_failed',
        message: error instanceof Error ? error.message : 'Unknown error' }));
    } finally { request.signal.removeEventListener('abort', onAbort); }
  })());
  const filename = encodeURIComponent(`${name}.zip`).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
  return new Response(body, { headers: {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}
