import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { describeAllowedTypes } from '../shared/formats';
import { isFolder, MAX_BULK_FILES, type Principal } from '../shared/types';
import { checkUploads, createUpload, getFile, getFileFilters, getFileWithRetention, listExplorer, listFilesWithRetention, setPermanent, uploadFile } from './files';
import { allowedFileTypes, cleanFolder, HttpError, isHttpError, maxFileBytes } from './http';
import { deleteFilePermanently, restoreFile, trashFile } from './trash';
import { manageFiles } from './bulk';
import { uploadFileReference } from './file-transfer';
import { prepareDownloadLink, prepareUploadBatch, prepareUploadLink } from './transfer-links';
import { feedbackSchema, submitFeedback } from './feedback';

export const MAX_MCP_BODY = 8 * 1024 * 1024;
const MAX_MCP_FILE = 5 * 1024 * 1024;
const uploadDestination = {
  uploadId: z.uuid().optional(),
  replace: z.object({ id: z.uuid(), version: z.number().int().positive() }).optional(),
};

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, user: Principal): Promise<Response> {
  function serverFactory(): McpServer {
    const server = new McpServer({ name: 'dropshelf', version: '0.1.0' }, {
      instructions: 'For transfer-only requests, keep file bytes out of the model. Call create_upload with path for one local file or folder for a signed batch. Follow the returned HTTP instructions in a local script. Use list_folder to browse a folder. For a client-provided file reference, use upload_file_reference. Use get_download_link to save an attachment without opening it. Single-use links authorize their own requests. Keep these links private and request a new link if one expires or a transfer stops. Use upload_file only for content the user intends to send inline. Use submit_feedback to report a Drop Shelf issue or suggest an improvement to the team. Keep file contents, private links, personal data, and credentials out of reports.',
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
    server.registerTool('submit_feedback', {
      title: 'Send Drop Shelf feedback to Slack',
      description: 'Send one issue or improvement and a proposed fix to this instance’s Slack feedback channel. Describe the affected tool with sample data. Omit file contents, private links, personal data, and credentials.',
      inputSchema: feedbackSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, report => result(() => submitFeedback(env, report)));
    server.registerTool('list_files', {
      description: 'List team files or Trash, including permanent and expiresAt (Unix milliseconds or null). Sort by newest (default), oldest, or name (A–Z). Date sorting uses the last update time for files and Trash time for Trash. Search file names with q. Filter with a MIME type or image/* and an author ID from get_file_filters. Keep the same view, filters, and sort with nextCursor.',
      inputSchema: { cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(100).optional(), view: z.enum(['files', 'trash']).default('files'), q: z.string().max(200).optional(), type: z.string().max(100).optional(), author: z.string().max(256).optional(), sort: z.enum(['newest', 'oldest', 'name']).default('newest') },
      annotations: { readOnlyHint: true },
    }, ({ cursor, limit, view, q, type, author, sort }) => result(() => listFilesWithRetention(env, cursor ?? null, limit, view, { q, type, author, sort })));
    server.registerTool('list_folder', {
      title: 'List files and subfolders',
      description: 'List direct children of a folder, or omit folder for the root. Set recursive to true to list all files below it. Each entry has permanent and expiresAt (Unix milliseconds or null). A folder reports the earliest deadline, how many files are permanent, and whether new files directly in it inherit permanence. Use get_download_link for a signed download. Keep folder, recursive, and sort with nextCursor.',
      inputSchema: {
        folder: z.string().min(1).max(1025).optional(),
        recursive: z.boolean().default(false),
        sort: z.enum(['name', 'newest', 'oldest']).default('name'),
        cursor: z.string().max(4096).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    }, ({ folder, recursive, sort, cursor, limit }) => result(async () => {
      const query = { folder: folder === undefined ? undefined : cleanFolder(folder), sort };
      const page = recursive
        ? await listFilesWithRetention(env, cursor ?? null, limit, 'files', query)
        : await listExplorer(env, cursor ?? null, limit, 'files', query);
      return {
        total: page.total, nextCursor: page.nextCursor,
        entries: ('entries' in page ? page.entries : page.files).map(entry => {
          const { id, name, path, downloadUrl, permanent } = entry;
          const expiresAt = 'expiry' in entry ? entry.expiry?.firstAt ?? null : entry.expiresAt;
          const common = { id, name, path, downloadUrl, permanent, expiresAt };
          if (isFolder(entry)) return { kind: 'folder', ...common, fileCount: entry.fileCount,
            permanentCount: entry.permanentCount, permanentForNewFiles: entry.permanentForNewFiles };
          return { kind: 'file', ...common, url: entry.url, contentType: entry.contentType, size: entry.size };
        }),
      };
    }));
    server.registerTool('get_file_filters', {
      description: 'List file types and uploader IDs for filtering all files in a view, including older pages.',
      inputSchema: { view: z.enum(['files', 'trash']).default('files') }, annotations: { readOnlyHint: true },
    }, ({ view }) => result(() => getFileFilters(env, view)));
    server.registerTool('get_file', {
      description: 'Get file metadata, protected URLs, Trash state, permanent, and expiresAt. The timestamp is in Unix milliseconds or null if no deadline applies. In Trash it is the deadline for deletion.',
      inputSchema: { id: z.uuid() }, annotations: { readOnlyHint: true },
    }, ({ id }) => result(() => getFileWithRetention(env, id)));
    server.registerTool('set_permanent', {
      title: 'Set file or folder retention',
      description: 'Choose one active file by id or one folder by relative path. Set permanent to true to keep it, or false to restart its 30-day expiry. A folder setting replaces all settings below it and applies to future uploads. Returns the updated record with permanent and expiresAt (Unix milliseconds or null).',
      inputSchema: z.strictObject({ id: z.uuid().optional(), folder: z.string().min(1).max(1025).optional(), permanent: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, ({ id, folder, permanent }) => result(async () => {
      if ((id === undefined) === (folder === undefined)) throw new HttpError(400, 'Supply exactly one file ID or folder path.');
      return setPermanent(env, id ?? `folder:${cleanFolder(folder!)}`, permanent);
    }));
    server.registerTool('get_download_link', {
      title: 'Download an original file',
      description: 'Get an attachment link for a transfer-only download. When single-use transfers are enabled, downloadUrl authorizes one GET for ten minutes. Follow usage with an HTTP client to save the original bytes to a local file without opening it. Use the Access-protected browserDownloadUrl for an interactive download. Use list_files to find the file ID.',
      inputSchema: { id: z.uuid() }, annotations: { readOnlyHint: true },
    }, ({ id }) => result(async () => {
      const file = await getFile(env, id);
      if (file.trashedAt !== null || file.deletionPending) throw new HttpError(404, 'The file was not found.');
      return prepareDownloadLink(env, user, file);
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
      description: 'Pass path for one single-use file PUT link, or folder for one single-use batch POST link. Follow usage in a local script. For a batch, POST a list of files and use the returned PUT links in the script. Signed links authorize their own HTTP requests and expire after ten minutes. Check existing paths first and use replace with path for a confirmed replacement. Reuse an uploadId to group files. Call without arguments for an interactive upload or an Access-protected batch.',
      inputSchema: {
        path: z.string().min(1).max(1024).optional(), folder: z.string().min(1).max(1025).optional(),
        contentType: z.string().max(100).optional(),
        sizeBytes: z.number().int().nonnegative().optional(), ...uploadDestination,
      },
    }, ({ path, folder, contentType, sizeBytes, uploadId, replace }) => result(async () => {
      const origin = new URL(env.APP_ORIGIN).origin;
      const settings = { browserUploadUrl: `${origin}/#drop-zone`, maxFileBytes: maxFileBytes(env), maxMcpFileBytes: MAX_MCP_FILE };
      if (folder !== undefined) {
        if (path !== undefined || contentType !== undefined || sizeBytes !== undefined || replace !== undefined) {
          throw new HttpError(400, 'Use folder and an optional uploadId for a signed batch. Send the file paths, sizes, and types in the HTTP request.');
        }
        return { ...settings, ...await prepareUploadBatch(env, user, folder, uploadId) };
      }
      if (path !== undefined) return { ...settings, ...await prepareUploadLink(env, user, { path, contentType, sizeBytes, uploadId, replace }) };
      if (contentType !== undefined || sizeBytes !== undefined || uploadId !== undefined || replace !== undefined) {
        throw new HttpError(400, 'Supply a destination path to request a single-use upload link.');
      }
      const batchId = await createUpload(env, user);
      return {
        ...settings, uploadId: batchId, uploadUrl: `${origin}/api/uploads/${batchId}`,
        usage: 'For a single-use link, call create_upload again with a path and this uploadId. For a batch HTTP upload, use Cloudflare Access with PUT, path, Content-Type, and Content-Length.',
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
