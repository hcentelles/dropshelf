import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { describeAllowedTypes } from '../shared/formats';
import type { Principal } from '../shared/types';
import { createUpload, getFile, listFiles, uploadFile } from './files';
import { allowedFileTypes, HttpError } from './http';

export const MAX_MCP_BODY = 8 * 1024 * 1024;
const MAX_MCP_FILE = 5 * 1024 * 1024;

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, user: Principal): Promise<Response> {
  function serverFactory(): McpServer {
    const server = new McpServer({ name: 'dropshelf', version: '0.1.0' });
    const result = async (action: () => Promise<unknown>) => {
      try {
        const value = await action();
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const,
          text: error instanceof HttpError ? error.message : 'The operation failed. Try again.' }] };
      }
    };
    server.registerTool('whoami', {
      description: 'Return the verified identity used to label uploads.',
      annotations: { readOnlyHint: true },
    }, async () => ({ content: [{ type: 'text', text: JSON.stringify(user) }] }));
    server.registerTool('list_files', {
      description: 'List team files, newest first. Use nextCursor to get the next page.',
      inputSchema: { cursor: z.string().max(512).optional(), limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true },
    }, ({ cursor, limit }) => result(() => listFiles(env, cursor ?? null, limit)));
    server.registerTool('get_file', {
      description: 'Get a file record and its protected browser and download URLs.',
      inputSchema: { id: z.uuid() }, annotations: { readOnlyHint: true },
    }, ({ id }) => result(() => getFile(env, id)));
    server.registerTool('create_upload', {
      description: 'Start a group of files. Reuse its uploadId for a folder so relative paths work. For a file over 5 MiB, PUT its raw bytes to the returned uploadUrl with ?path=relative/path, Content-Type, Content-Length, and your Access authorization.',
    }, () => result(async () => {
      const uploadId = await createUpload(env, user);
      return { uploadId, uploadUrl: `${env.APP_ORIGIN}/api/uploads/${uploadId}`, maxMcpFileBytes: MAX_MCP_FILE };
    }));
    server.registerTool('upload_file', {
      description: `Upload a permitted file, up to 5 MiB. Allowed types: ${describeAllowedTypes(allowedFileTypes(env))}. Use utf8 for text and base64 for binary files. Reuse uploadId and preserve relative paths for a folder. The server records your verified identity.`,
      inputSchema: {
        path: z.string().min(1).max(1024), content: z.string().max(7 * 1024 * 1024),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
        contentType: z.string().max(100).optional(), uploadId: z.uuid().optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    }, ({ path, content, encoding, contentType, uploadId }) => result(async () => {
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
        size: bytes.byteLength, body: bytes, source: 'mcp',
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
