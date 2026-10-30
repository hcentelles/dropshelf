# Drop Shelf

A private file shelf for teams. Drop files or folders, then copy links that open in a browser. Cloudflare Access controls who can upload, list, and open files.

## Features

- Drop files and folders, or select them from your computer.
- Configure allowed file types through a Worker variable. The default includes HTML, images, Markdown, CSV, PDF, CSS, JavaScript, and ZIP. Skip unsupported files and report the result.
- Browse folders at each level, with parent links and browser history. Folder actions include all files below that folder.
- Keep folder paths so relative images, CSS, and JavaScript work.
- Keep open pages current through a live connection. Uploads, Trash changes, restores, and deletions appear without a page refresh.
- Sort files and Trash by newest first, oldest first, or name A–Z, with infinite scroll, uploader identity, dates, and copy actions.
- Search file names and filter by file type or author across the full file history.
- Choose System, Light, or Dark in the account menu. Save the choice on this device and apply it before the page appears.
- Use the Drop Shelf icon for browser tabs and installed web apps.
- Select files across pages. Copy their links, move them to Trash, restore them, or delete them permanently.
- Open or download each file through a stable, protected URL.
- Download a complete folder as a ZIP file, including files in its subfolders.
- Move files to Trash, restore their original links, and delete files permanently from Trash.
- Move old files and folders to Trash automatically, then delete them after a separate Trash period. Configure both periods for each instance.
- Use email codes to sign in with Cloudflare Access.
- Give agents the same file service through a remote MCP server.
- Run separate instances from one codebase.

## Stack

| Service | Purpose |
| --- | --- |
| Workers | Browser UI, HTTP API, file delivery, and MCP |
| R2 | Private file storage |
| SQLite Durable Object | File index, uploader records, and live change notices |
| Access | Email-code login and Managed OAuth for MCP |

The app and uploaded content use separate origins. Both Workers use the same R2 bucket and one SQLite Durable Object. The app Worker owns the object; the content Worker uses a cross-Worker binding. Uploads are available as soon as storage and the file record are ready. An upload does not need a deployment.

## Run locally

Use Node.js 24 or later.

```sh
npm ci
npm run build
npm run dev
```

Open [http://localhost:8787](http://localhost:8787). Local file links use `http://127.0.0.1:8787` to keep content on a separate origin. Use these exact addresses.

Local development uses `developer@example.test`. This identity is accepted only on loopback addresses. Production configuration clears this setting and requires a valid Access token.

After a UI change, run `npm run build` again. Wrangler reloads Worker code during development.

```sh
npm run types
npm run check
```

The checks include TypeScript, a production UI build, and tests in the Workers runtime with local R2 and a SQLite Durable Object.

## Deploy

Follow the [deployment guide](docs/deployment.md). It covers account login, R2, Durable Objects, email-code login, Access policies, Managed OAuth, both Workers, custom domains, verification, and updates.

Keep deployment files outside the repository. The setup script creates them from a private input file. Start with [instance.example.json](instance.example.json). Each instance has its own bucket, Durable Object namespace, Access application, and two Worker names.

## Current configuration

Open the user menu and select **Configuration**. This read-only dialog loads the current Worker values each time it opens. It shows upload limits, allowed file types, expiry periods, service URLs, and the authentication mode. Each configurable value shows its environment variable name. Access configuration and secret values are not returned to the browser.

Runtime settings are Cloudflare Worker environment variables or secrets, read through `env`. Manage them in **Worker → Settings → Variables and Secrets**. The private `instance.json` file is an input to the deployment script; the Worker does not read that file. Keep deployment inputs in sync with dashboard changes before a later deployment. Use secrets for credentials.

## Allowed file types

Set the `ALLOWED_FILE_TYPES` Worker variable to a comma-separated list of extensions or MIME types:

```text
image/*,.html,.htm,.md,.markdown,.csv,.pdf,.css,.js,.zip
```

The browser picker, folder filter, server checks, and MCP tools use this setting. For deployment, set `allowedFileTypes` in your private instance file, generate the configuration again, and redeploy. A dashboard variable change must also be saved in that private file so a later deployment does not replace it.

PDF links open in the browser PDF viewer. Markdown and CSV links open as UTF-8 text in the browser. Download links keep the original bytes, name, and media type. Existing file links stay valid when you change the upload allowlist.

ZIP uploads keep their original bytes. The server does not extract them. ZIP links download the file.

## Download a folder

Open the folder's **More options** menu and select **Download folder as ZIP**. The ZIP contains the selected folder and all its active files, including subfolders and files from separate uploads. Search filters do not restrict the download. Files in Trash are excluded.

The content Worker streams and compresses one file at a time from private R2. Access protects the download. The server does not create a stored ZIP copy or load the complete folder into memory. ZIP64 supports archives larger than 4 GiB. A folder download supports up to 5,000 files; Worker plan limits can be lower. If a required file becomes unavailable, the download fails. Retry after the file list is current.

## Connect an agent

Add `https://YOUR_APP_HOST/mcp` as a remote HTTP MCP server in your client. Select OAuth and complete the Access login. The client must support OAuth resource indicators (RFC 8707).

In the web app, select **Connect MCP** above the upload area. The first section has generic setup instructions that you can copy and paste into an agent. The page also shows manual setup steps, the instance URL, available tools, and upload limits.

Available tools:

| Tool | Purpose |
| --- | --- |
| `whoami` | Show the verified upload identity |
| `list_files` | Search and filter files, and get the next page cursor |
| `get_file_filters` | Get file types and authors for the selected view |
| `get_file` | Get a file record and protected URLs |
| `create_upload` | Start a group for files that share relative paths |
| `check_uploads` | Check full paths and get current files before replacement approval |
| `upload_file` | Upload an allowed text or binary file and return its URLs |
| `trash_file` | Move a file to Trash and stop serving its links |
| `restore_file` | Restore a file and its original links |
| `delete_file_permanently` | Remove a file from Trash after explicit confirmation |
| `trash_files`, `restore_files`, `delete_files_permanently` | Manage up to 10 selected file IDs per call |

For a folder, call `create_upload`, then pass its `uploadId` and each relative path to `upload_file`. Folders with the same full path merge across upload groups. HTML can load images, CSS, and JavaScript added to that folder in later uploads.

## File replacement

The shelf has one shared folder tree. Uploading inside an open folder adds files there. The browser checks each full path before upload. If a file exists, choose **Replace**, **Skip**, or **Cancel upload**. You can apply Replace or Skip to the other existing files in that upload.

Replacement keeps the file ID, browser URL, and download URL. It updates the contents, size, author, and update time. The old contents stay available until the new upload completes. If another user changes the file after approval, the app asks again. Replaced contents cannot be recovered from Trash.

MCP clients must call `check_uploads`, ask for approval, and pass the returned file ID and version in `upload_file.replace`. See the [replacement instructions](docs/mcp.md#replace-an-existing-file).

The [MCP guide](docs/mcp.md) includes authentication, tool examples, larger uploads, and service identities.

## Trash

Open a file's options menu and select **Move to Trash**. Open **Trash** from the account menu to restore it or select **Delete permanently**. Manual permanent deletion requires a confirmation and only works on files already in Trash.

Use the checkboxes for bulk actions. The header checkbox selects loaded items. **Select all** includes all pages at the current folder level for the current search and filters. A selected folder includes all files below it, including files hidden by a filter. Changing a filter or leaving the view clears the selection.

In Trash, **Delete all** collects every file across all pages, including files hidden by filters. The confirmation shows the captured count. Files added after that step are excluded. A failed deletion can be retried for only the files that failed.

Any approved team member can manage Trash. Service identities use the same rules. Files in Trash stop serving content and previews, but keep their stored bytes until permanent deletion. Restore keeps the original path, uploader, upload dates, and URL. It starts a new active retention period.

Permanent deletion removes the R2 object and file record. Link reservations, the file ID, and an object-key hash remain to make retries safe and prevent reuse of a deleted URL. To upload a new file at the same path after moving a file to Trash, start a new upload group. Restore is blocked while another active file uses that path.

## Automatic expiry

The default settings move files to Trash after **30 days**, then delete them permanently after **7 days in Trash**. An hourly job runs on the app Worker, including when no browser is open. Actions occur on the next successful check after each period ends.

In Files, point to or focus the date to see the remaining time and exact expiry date. In Trash, the **Deletes in** column stays visible. On a phone, this value appears below the file name. A Trash folder with different deletion dates shows a range. The values update each minute while the page is visible.

- A file at the root uses its last completed upload, replacement, or restore date. Opening, downloading, or previewing a file does not extend its life.
- A top-level folder is one expiry group. Its date is the latest upload, replacement, or restore among its active files, including nested folders and files from other upload groups. The whole group moves to Trash together. A pending upload blocks expiry for that group. This keeps HTML pages and their assets together.
- The Trash period starts at the actual move to Trash, including a manual move. An old file still gets the full Trash period. Files in Trash are then deleted by their own Trash dates.
- Restore starts a full new active period. Upload dates and links stay unchanged. Repeated restore calls for an already active file do not extend the period.

Set the `FILE_RETENTION_DAYS` and `TRASH_RETENTION_DAYS` environment variables on the Workers. The deployment script maps `fileRetentionDays` and `trashRetentionDays` to these variables. Use whole days from `1` to `36500`, or `0` to disable a step. Missing Worker variables disable that step for older deployments. Invalid values stop the job before it changes data.

Configuration changes apply to existing files and Trash. Reducing a period can make existing items due at the next check. The job deletes at most 100 files per run; a larger backlog can take more than one run. Failed deletions stay pending and retry on the next run. Deletions that already started also retry if automatic deletion is later disabled.

## Live updates

The app receives change notices in the background. If the connection drops, the app reconnects and reads the current state. Returning to the page or restoring the network also starts a refresh.

Updates keep the current folder, search, sort order, loaded range, and available selections. A removed item leaves the selection. An upload, bulk action, open file menu, or delete dialog delays list changes until that operation ends. The channel sends only change notices; the authenticated API supplies the file data.

## Limits

- Default file limit: 100 MiB. MCP inline uploads have a 5 MiB decoded limit. Larger files can use the authenticated HTTP upload endpoint.
- Browser image support varies. An accepted image can still be downloaded if the browser cannot display it.
- CSS and JavaScript are enabled by default. Fonts and other types require an allowlist change. HTML can contain inline CSS and JavaScript, and can reference accepted files by relative path.
- Folders come from file paths. Empty folders are not stored. Folders with the same full path merge. Paths are case-sensitive.
- Uploaded HTML has a content security policy that blocks network API calls, form submissions, objects, and framing. See [security](docs/security.md).
- An approved team member can read all ready files in that instance. There are no per-file access rules.
- Access Managed OAuth is a Cloudflare beta feature. Test the clients you plan to use.
- Storage, requests, database use, and Access seats follow your Cloudflare plan. Free allowances are shared with other use in the account.

## Repository status

This is an early project. Keep deployments private. A public release and license have not been selected.
