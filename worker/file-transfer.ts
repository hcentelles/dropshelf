import type { Principal, ReplaceFile, SharedFile } from '../shared/types';
import { createUpload, uploadFile } from './files';
import { cleanPath, HttpError, maxFileBytes } from './http';

interface FileReference {
  download_url: string;
  file_name?: string;
  mime_type?: string;
}

interface TransferDestination {
  path?: string;
  uploadId?: string;
  replace?: ReplaceFile;
}

export async function uploadFileReference(
  env: Env, user: Principal, file: FileReference, destination: TransferDestination,
): Promise<SharedFile> {
  const name = destination.path ?? file.file_name;
  if (!name) throw new HttpError(400, 'Supply the original file name as the path.');
  const path = cleanPath(name);
  const limit = maxFileBytes(env);
  const source = URL.parse(file.download_url);
  if (source?.origin !== 'https://files.oaiusercontent.com' || source.username || source.password || source.hash) {
    throw new HttpError(400, 'Use a file reference from ChatGPT or upload directly to Drop Shelf.');
  }

  let response: Response;
  try {
    response = await fetch(source, {
      redirect: 'manual', headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new HttpError(502, 'The file could not be retrieved. Select the file again or upload directly to Drop Shelf.');
  }

  try {
    if (response.status !== 200) {
      throw new HttpError(502, 'The file could not be retrieved. Select the file again or upload directly to Drop Shelf.');
    }
    const length = response.headers.get('Content-Length');
    const encoding = response.headers.get('Content-Encoding')?.toLowerCase();
    if (!length || !/^\d+$/.test(length) || (encoding && encoding !== 'identity')) {
      throw new HttpError(502, 'The file source did not provide a byte count for the original file. Upload directly to Drop Shelf.');
    }
    const size = Number(length);
    if (!Number.isSafeInteger(size) || size > limit) throw new HttpError(413, 'The file exceeds the size limit.');
    if (size > 0 && !response.body) throw new HttpError(502, 'The file source returned an empty response.');

    return await uploadFile(env, user, {
      uploadId: destination.uploadId ?? await createUpload(env, user), path, size,
      type: file.mime_type ?? response.headers.get('Content-Type') ?? '',
      body: response.body ?? new Uint8Array(), source: 'mcp', replace: destination.replace,
    });
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
}
