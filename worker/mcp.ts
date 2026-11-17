import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { describeAllowedTypes } from '../shared/formats';
import { MAX_BULK_FILES, type Principal } from '../shared/types';
import { checkUploads, createUpload, getFile, listFiles, uploadFile } from './files';
import { allowedFileTypes, HttpError, isHttpError, maxFileBytes } from './http';
import { deleteFilePermanently, restoreFile, trashFile } from './trash';
import { getFileFilters } from './files';
import { manageFiles } from './bulk';
import { uploadFileReference } from './file-transfer';

export const MAX_MCP_BODY = 8 * 1024 * 1024;
const MAX_MCP_FILE = 5 * 1024 * 1024;
const uploadDestination = {
  uploadId: z.uuid().optional(),
  replace: z.object({ id: z.uuid(), version: z.number().int().positive() }).optional(),
};

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, user: Principal): Promise<Response> {
  function serverFactory(): McpServer {
    const server = new McpServer({ name: 'dropshelf', version: '0.1.0' }, {
      instructions: 'For transfer-only requests, keep file bytes out of the model. Use upload_file_reference for a client-provided file reference, or create_upload for direct HTTP or browser transfer. Use get_download_link for downloads and save the attachment without opening it. Use upload_file only for content the user intends to send inline. Never read, preview, re-encode, or paste a file into tool arguments for a transfer.',
    });
    const result = async (action: () => Promise<unknown>) => {
      try {
        const value = await action();
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const,
          text: isHttpError(error) ? JSON.stringify({ error: error.message, status: error.status, ...error.details }) : 'The operation failed. Try again.' }] };
      }
    };
    server.registerTool('whoami', {
      description: 'Return the verified identity used to label uploads.',
      annotations: { readOnlyHint: true },
    }, async () => ({ content: [{ type: 'text', text: JSON.stringify(user) }] }));
    server.registerTool('list_files', {
      description: 'List team files or Trash. Sort by newest (default), oldest, or name (A–Z). Date sorting uses the last update time for files and Trash time for Trash. Search file names with q. Filter with a MIME type or image/* and an author ID from get_file_filters. Keep the same view, filters, and sort with nextCursor.',
      inputSchema: { cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(100).optional(), view: z.enum(['files', 'trash']).default('files'), q: z.string().max(200).optional(), type: z.string().max(100).optional(), author: z.string().max(256).optional(), sort: z.enum(['newest', 'oldest', 'name']).default('newest') },
      annotations: { readOnlyHint: true },
    }, ({ cursor, limit, view, q, type, author, sort }) => result(() => listFiles(env, cursor ?? null, limit, view, { q, type, author, sort })));
    server.registerTool('get_file_filters', {
      description: 'List file types and uploader IDs for filtering all files in a view, including older pages.',
      inputSchema: { view: z.enum(['files', 'trash']).default('files') }, annotations: { readOnlyHint: true },
    }, ({ view }) => result(() => getFileFilters(env, view)));
    server.registerTool('get_file', {
      description: 'Get a file record, its Trash state, and protected URLs. Files in Trash do not serve content.',
      inputSchema: { id: z.uuid() }, annotations: { readOnlyHint: true },
    }, ({ id }) => result(() => getFile(env, id)));
    server.registerTool('get_download_link', {
      title: 'Download an original file',
      description: 'Get a protected attachment link for a transfer-only download. Return the link to the user or save it with a browser or HTTP client without opening the file or returning its bytes to the model. Use list_files to find the file ID.',
      inputSchema: { id: z.uuid() }, annotations: { readOnlyHint: true },
    }, ({ id }) => result(async () => {
      const file = await getFile(env, id);
      if (file.trashedAt !== null || file.deletionPending) throw new HttpError(404, 'The file was not found.');
      return { id: file.id, name: file.name, path: file.path, contentType: file.contentType, size: file.size, downloadUrl: file.downloadUrl };
    }));
    server.registerTool('trash_file', {
      description: 'Move a file to Trash. Shared links stop serving it. Any approved member can restore it until permanent deletion starts.',
      inputSchema: { id: z.uuid() }, annotations: { destructiveHint: true, idempotentHint: true },
    }, ({ id }) => result(() => trashFile(env, user, id)));
    server.registerTool('restore_file', {
      description: 'Restore a file from Trash with its original shared URL.',
      inputSchema: { id: z.uuid() }, annotations: { destructiveHint: false, idempotentHint: true },
    }, ({ id }) => result(() => restoreFile(env, id)));
    server.registerTool('delete_file_permanently', {
      description: 'Permanently remove a file that is already in Trash. This cannot be undone. Confirm the user wants permanent deletion, then pass confirm: true.',
      inputSchema: { id: z.uuid(), confirm: z.literal(true) },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, ({ id, confirm }) => result(() => deleteFilePermanently(env, id, confirm)));
    for (const [name, action, description] of [
      ['trash_files', 'trash', 'Move selected files to Trash.'],
      ['restore_files', 'restore', 'Restore selected files and their original URLs.'],
      ['delete_files_permanently', 'delete', 'Permanently delete selected files already in Trash. Confirm the user wants this, then pass confirm: true.'],
    ] as const) {
      server.registerTool(name, {
        description: `${description} Send up to ${MAX_BULK_FILES} IDs per call. Each result reports success or failure. For all files, collect IDs with list_files before you start.`,
        inputSchema: { ids: z.array(z.uuid()).min(1).max(MAX_BULK_FILES), confirm: z.literal(true).optional() },
        annotations: { destructiveHint: action !== 'restore', idempotentHint: true },
      }, ({ ids, confirm }) => result(() => manageFiles(env, user, action, ids, confirm === true)));
    }
    server.registerTool('create_upload', {
      description: 'Start a direct upload of any allowed size with no file contents in MCP. Use a client to PUT the original bytes to uploadUrl with ?path=relative/path, Content-Type, Content-Length, and Access authorization. If the client cannot do this, open browserUploadUrl and select the files in Drop Shelf. Check existing paths first. A confirmed HTTP replacement also requires replaceId and replaceVersion query parameters.',
    }, () => result(async () => {
      const origin = new URL(env.APP_ORIGIN).origin;
      const fileLimit = maxFileBytes(env);
      const uploadId = await createUpload(env, user);
      return {
        uploadId, uploadUrl: `${origin}/api/uploads/${uploadId}`, browserUploadUrl: `${origin}/#drop-zone`,
        maxFileBytes: fileLimit, maxMcpFileBytes: MAX_MCP_FILE,
      };
    }));
    server.registerTool('check_uploads', {
      description: 'Check up to 100 full file paths before uploading. If a file exists, show the path and ask the user before replacing it. Use the returned file ID and version only after confirmation. Files with different paths merge into existing folders.',
      inputSchema: { paths: z.array(z.string().min(1).max(1024)).min(1).max(100) },
      annotations: { readOnlyHint: true },
    }, ({ paths }) => result(() => checkUploads(env, paths)));
    server.registerTool('upload_file_reference', {
      title: 'Transfer an original file to Drop Shelf',
      description: 'Upload a file that the client supplies by reference. Drop Shelf copies the original bytes directly from the file host. Use the original file name unless the user gives a destination path. Check existing paths and get approval before using replace with the current ID and version. If the client cannot supply a file reference, use create_upload for direct transfer.',
      inputSchema: z.strictObject({
        file: z.strictObject({
          download_url: z.string().min(1).max(8192), file_id: z.string().min(1).max(512),
          mime_type: z.string().max(100).optional(), file_name: z.string().max(1024).optional(),
        }),
        path: z.string().min(1).max(1024).optional(), ...uploadDestination,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: { 'openai/fileParams': ['file'] },
    }, ({ file, path, uploadId, replace }) => result(() => uploadFileReference(env, user, file, { path, uploadId, replace })));
    server.registerTool('upload_file', {
      description: `Upload inline content, up to 5 MiB. This call includes all file bytes. For transfer-only requests use upload_file_reference or create_upload instead. Allowed types: ${describeAllowedTypes(allowedFileTypes(env))}. Paths belong to one shared folder tree. Existing files require user confirmation: call check_uploads, ask the user, then pass replace with the exact file ID and version. A replacement keeps the file URL. If the version changes, ask again. Use utf8 for text and base64 for binary files. The server records your verified identity.`,
      inputSchema: {
        path: z.string().min(1).max(1024), content: z.string().max(7 * 1024 * 1024),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
        contentType: z.string().max(100).optional(), ...uploadDestination,
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    }, ({ path, content, encoding, contentType, uploadId, replace }) => result(async () => {
      let bytes: Uint8Array;
      if (encoding === 'utf8') bytes = new TextEncoder().encode(content);
      else {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
          throw new HttpError(400, 'The base64 content is not valid.');
        }
        bytes = Uint8Array.from(atob(content), char => char.charCodeAt(0));
      }
      if (bytes.byteLength > MAX_MCP_FILE) throw new HttpError(413, 'Use the HTTP upload endpoint for files over 5 MiB.');
      return uploadFile(env, user, {
        uploadId: uploadId ?? await createUpload(env, user), path, type: contentType ?? '',
        size: bytes.byteLength, body: bytes, source: 'mcp', replace,
      });
    }));
    return server;
  }
  return createMcpHandler(serverFactory, {
    route: '/mcp', allowedHostnames: [new URL(env.APP_ORIGIN).hostname],
    allowedOriginHostnames: [new URL(env.APP_ORIGIN).hostname],
    authContext: { props: { userId: user.id, email: user.email, kind: user.kind } },
  })(request, env, ctx);
}
