# Drop Shelf

A private file shelf for teams. Drop files or folders, then copy links that open in a browser. Cloudflare Access controls who can upload, list, and open files.

## Features

- Drop files and folders, or select them from your computer.
- Configure allowed file types through a Worker variable. The default includes HTML, images, Markdown, CSV, and PDF. Skip unsupported files and report the result.
- Keep folder paths so relative image links work.
- Sort files and Trash by newest first, oldest first, or name A–Z, with infinite scroll, uploader identity, dates, and copy actions.
- Search file names and filter by file type or author across the full file history.
- Select files across pages. Copy their links, move them to Trash, restore them, or delete them permanently.
- Open or download each file through a stable, protected URL.
- Move files to Trash, restore their original links, and delete files permanently from Trash.
- Use email codes to sign in with Cloudflare Access.
- Give agents the same file service through a remote MCP server.
- Run separate instances from one codebase.

## Stack

| Service | Purpose |
| --- | --- |
| Workers | Browser UI, HTTP API, file delivery, and MCP |
| R2 | Private file storage |
| D1 | SQLite file index and uploader records |
| Access | Email-code login and Managed OAuth for MCP |

The app and uploaded content use separate origins. Both Workers use the same R2 bucket and D1 database. Uploads are available as soon as storage and the file record are ready. An upload does not need a deployment.

## Run locally

Use Node.js 24 or later.

```sh
npm ci
npm run build
npm run db:local
npm run dev
```

Open [http://localhost:8787](http://localhost:8787). Local file links use `http://127.0.0.1:8787` to keep content on a separate origin. Use these exact addresses.

Local development uses `developer@example.test`. This identity is accepted only on loopback addresses. Production configuration clears this setting and requires a valid Access token.

After a UI change, run `npm run build` again. Wrangler reloads Worker code during development.

```sh
npm run types
npm run check
```

The checks include TypeScript, a production UI build, and tests in the Workers runtime with local R2 and D1.

## Deploy

Follow the [deployment guide](docs/deployment.md). It covers account login, R2, D1, email-code login, Access policies, Managed OAuth, both Workers, custom domains, verification, and updates.

Keep all instance settings outside the repository. The setup script creates deployment files from a private instance file. Start with [instance.example.json](instance.example.json). Each instance has its own bucket, database, Access application, and two Worker names.

## Allowed file types

Set the `ALLOWED_FILE_TYPES` Worker variable to a comma-separated list of extensions or MIME types:

```text
image/*,.html,.htm,.md,.markdown,.csv,.pdf
```

The browser picker, folder filter, server checks, and MCP tools use this setting. For deployment, set `allowedFileTypes` in your private instance file, generate the configuration again, and redeploy. A dashboard variable change must also be saved in that private file so a later deployment does not replace it.

PDF links open in the browser PDF viewer. Markdown and CSV links open as UTF-8 text in the browser. Download links keep the original bytes, name, and media type. Existing file links stay valid when you change the upload allowlist.

## Connect an agent

Add `https://YOUR_APP_HOST/mcp` as a remote HTTP MCP server in your client. Select OAuth and complete the Access login. The client must support OAuth resource indicators (RFC 8707).

In the web app, select **Connect MCP** beside the **Shared files** heading. The first section has generic setup instructions that you can copy and paste into an agent. The page also shows manual setup steps, the instance URL, available tools, and upload limits.

Available tools:

| Tool | Purpose |
| --- | --- |
| `whoami` | Show the verified upload identity |
| `list_files` | Search and filter files, and get the next page cursor |
| `get_file_filters` | Get file types and authors for the selected view |
| `get_file` | Get a file record and protected URLs |
| `create_upload` | Start a group for files that share relative paths |
| `upload_file` | Upload an allowed text or binary file and return its URLs |
| `trash_file` | Move a file to Trash and stop serving its links |
| `restore_file` | Restore a file and its original links |
| `delete_file_permanently` | Remove a file from Trash after explicit confirmation |
| `trash_files`, `restore_files`, `delete_files_permanently` | Manage up to 10 selected file IDs per call |

For a folder, call `create_upload`, then pass its `uploadId` and each relative path to `upload_file`. HTML and its images must share the same upload group.

The [MCP guide](docs/mcp.md) includes authentication, tool examples, larger uploads, and service identities.

## Trash

Open a file's options menu and select **Move to Trash**. Open **Trash** from the account menu to restore it or select **Delete permanently**. Permanent deletion requires a confirmation and only works on files already in Trash.

Use the checkboxes for bulk actions. The header checkbox selects loaded files. **Select all matching files** includes all pages for the current search and filters. Changing a filter or leaving the view clears the selection.

In Trash, **Delete all** collects every file across all pages, including files hidden by filters. The confirmation shows the captured count. Files added after that step are excluded. A failed deletion can be retried for only the files that failed.

Any approved team member can manage Trash. Service identities use the same rules. Files in Trash stop serving content and previews, but keep their stored bytes until permanent deletion. Restore keeps the original path, uploader, date, and URL. Files have no automatic expiry in Trash.

Permanent deletion removes the R2 object and file record. A file ID and path hash remain to make retries safe and prevent reuse of a deleted URL. To upload a replacement at the same relative path after permanent deletion, start a new upload group.

## Limits

- Default file limit: 100 MiB. MCP inline uploads have a 5 MiB decoded limit. Larger files can use the authenticated HTTP upload endpoint.
- Browser image support varies. An accepted image can still be downloaded if the browser cannot display it.
- Separate CSS, JavaScript, fonts, and other types are skipped by the default allowlist. You can enable them in the Worker variable. HTML can contain inline CSS and JavaScript, and can reference accepted files in its upload group.
- Uploaded HTML has a content security policy that blocks network API calls, form submissions, objects, and framing. See [security](docs/security.md).
- An approved team member can read all ready files in that instance. There are no per-file access rules.
- Access Managed OAuth is a Cloudflare beta feature. Test the clients you plan to use.
- Storage, requests, database use, and Access seats follow your Cloudflare plan. Free allowances are shared with other use in the account.

## Repository status

This is an early project. Keep deployments private. A public release and license have not been selected.
