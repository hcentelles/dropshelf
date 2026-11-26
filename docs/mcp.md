# Remote MCP

The endpoint is `https://YOUR_APP_HOST/mcp`. It supports the Streamable HTTP transport. It uses the same file service, storage, and identity checks as the browser API.

For setup instructions in the app, select **Connect MCP** above the upload area, or open `https://YOUR_APP_HOST/#mcp`. The section uses the current instance URL, allowed file types, and upload limit.

The first section, **Set up with your agent**, has a **Copy instructions** button. Paste the instructions into your agent to configure its MCP client. They include the current server URL, transport, authentication steps, and connection checks. The instructions apply to any compatible client. They ask the agent to preserve existing settings and verify access with `whoami` and `list_files`. Complete any sign-in or access approval that the client requires. Manual setup steps follow this section.

## User authentication

Enable Access Managed OAuth on the self-hosted application. Add the remote URL in an MCP client that supports OAuth resource indicators (RFC 8707). The client opens a browser, the user enters the email code, and Access issues an OAuth token.

Access resolves the client token and sends a signed JWT to the Worker in `Cf-Access-Jwt-Assertion`. The Worker verifies its signature, issuer, audience, and expiry. It then reads the user's email. The uploader email cannot be set in tool arguments.

An OAuth token is not the Access JWT. Do not decode the opaque OAuth token or pass it as `Cf-Access-Jwt-Assertion`. Access handles that step.

Managed OAuth is currently in beta. Test your clients before team rollout. A normal browser cookie login by itself does not prove that an MCP client can authenticate.

## Session duration and renewal

Set these values on the Cloudflare Access application:

| Setting | Value | API field |
| --- | --- | --- |
| Browser session duration | 2 weeks (14 days) | `session_duration: "336h"` |
| Managed OAuth access token lifetime | 15 minutes | `oauth_configuration.grant.access_token_lifetime: "15m"` |
| Managed OAuth grant session duration | 2 weeks (14 days) | `oauth_configuration.grant.session_duration: "336h"` |

Leave the Allow policy's session duration at **Same as application**. A policy override can change the browser session duration. Existing sessions can keep their previous expiry; use a new login to test the new browser duration.

Cloudflare owns the browser cookie, OAuth grant, refresh token, and renewal checks. Drop Shelf does not store or renew sessions. A client that supports refresh tokens can renew access without an email code during the grant. Access evaluates the user's policy again when it refreshes a token. The new access token cannot outlive the grant.

The 14-day grant is a time limit, not a promise of permanent access through daily use. When the grant expires, the client must start authorization again. Access can use a valid browser login; otherwise the user must enter a new email code. A client without refresh support must start authorization when its access token expires.

The browser uses an Access cookie, not the MCP refresh token. When that cookie expires, Access checks its global login session and policies. If another login is needed, the user enters a new email code. A failed API request can require a page reload to start that login. Do not add application session storage to change this behavior.

See [Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/) and [Managed OAuth settings](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#managed-oauth-settings).

## Chat client setup

Use the hosted ChatGPT or Claude Chat client. No local MCP proxy or shared API key is needed. Each user signs in with an email allowed by the instance's Access policy.

### ChatGPT

1. Open **Plugins → Add → Add custom MCP server**.
2. Enter the instance name and `https://YOUR_APP_HOST/mcp`.
3. Select **OAuth**. In **Advanced OAuth settings**, keep **Dynamic Client Registration (DCR)**. Use the endpoints found from the server.
4. In Access, allow ChatGPT's OAuth return address under **Managed OAuth → Allowed redirect URIs**. Use the exact callback URL shown in ChatGPT's connection settings when available.
5. Create the plugin, connect it, and approve the Access request. Enter the email code if Access asks for one.
6. Select **Try in chat** and ask it to call only `whoami`.

ChatGPT can use `https://chatgpt.com/connector_platform_oauth_redirect` or an address under `https://chatgpt.com/connector/oauth/`. If registration happens before ChatGPT shows its exact callback, Access accepts the limited pattern `https://chatgpt.com/connector/oauth/*`. Replace that pattern with the exact callback after setup when available. Do not allow every HTTPS address. A registration error that says `redirect_uri is not allowed` means the callback is missing from Access.

See [ChatGPT authentication](https://developers.openai.com/plugins/build/auth) and [connecting a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt).

### Claude Chat

1. In Access, add `https://claude.ai/api/mcp/auth_callback` to **Managed OAuth → Allowed redirect URIs**.
2. In Claude, open **Customize → Connectors → Add → Add custom connector**.
3. Enter the instance name and `https://YOUR_APP_HOST/mcp`.
4. Select **Sign in now** and **Register automatically** for the OAuth client. Leave custom request headers empty.
5. Add the connector, select **Connect**, and approve the Access request. Enter the email code if Access asks for one.
6. Open a new **Chat** and ask it to call only the Drop Shelf `whoami` tool. Approve the tool call when asked.

See [Claude connector authentication](https://claude.com/docs/connectors/building/authentication#token-refresh). Claude can refresh before expiry or after an authentication failure.

## Test renewal in a chat client

Use a new OAuth connection after saving the Access settings:

1. Record the connection time. Call `whoami` and inspect the tool's returned identity.
2. Leave the connection in place for at least 16 minutes. Do not disconnect, sign in again, or authorize it again.
3. Ask the same client to make a new `whoami` call. Tell it not to reuse the previous answer or access files.
4. Approve the tool call if the chat asks. Tool approval is separate from an Access login.
5. Inspect the new tool result. A successful call after the original token lifetime, with no new authorization, confirms that the client kept access through renewal.

Repeat this check in ChatGPT and Claude Chat. Keep the timestamps and results in private deployment records. Do not put tokens or private identities in the repository. This test does not check the full 14-day expiry. That limit is verified from the Access settings.

## Send feedback to Slack

Use `submit_feedback` to report a problem with a tool or suggest a change. Supply a short `summary`, `details` with the observed and expected results, and a `proposedFix`. Include `stepsToReproduce` if you can repeat the issue with sample data. Keep file contents, private links, personal data, and credentials out of the report.

The tool sends one message to the Slack channel set for this instance. A successful call returns `submitted: true` and the Slack message timestamp (`messageTs`). If delivery is uncertain, check the channel before sending the same report again. See [Slack setup](deployment.md#enable-slack-feedback).

If a Slack secret is missing or empty, the tool returns an MCP error with status `503` before it contacts Slack. The error names each affected secret and tells you where to set it. A value that contains only spaces or other whitespace counts as empty.

## Transfer files as-is

Ask the agent to transfer the file as-is. The server instructions tell clients to use these tools for transfers without reading, modifying, or sending the file contents to the model:

| Task | Tool and next step |
| --- | --- |
| Upload a file supplied by a compatible ChatGPT client | Call `upload_file_reference` with the native file reference. Drop Shelf streams the file from its temporary OpenAI file URL. The reference and result contain file details and URLs. |
| Upload a local file | Call `create_upload` with `path`. Follow `usage` to send the file with `PUT` and the returned `Content-Type`. Reuse `uploadId` for more files in the same batch. |
| Upload a local folder | Call `create_upload` with `folder`. Pass the returned link to a script that sends the file list and transfers its files by HTTP. |
| Upload in a browser | Call `create_upload` without a path and open `browserUploadUrl`. Select the file in Drop Shelf. The browser starts its own batch. |
| Download a file | Find its ID with `list_files`, then call `get_download_link`. Follow `usage` to save the attachment locally. Give the user `browserDownloadUrl` for an interactive download. |

These tools carry no file bytes in MCP requests or results. The authenticated MCP connection starts each transfer. A single-use link authorizes one HTTP request for ten minutes. Use the returned method and URL. Keep the URL private and request a new one if it expires or a transfer stops. A download link applies to the file version at the time of issue.

### Upload a folder with a signed batch

Call `create_upload` once with the relative destination folder, such as `{"folder":"audit/project/run"}`. Pass `uploadUrl` to a local script. The script sends a JSON manifest with `POST` and `Content-Type: application/json`. Get the file sizes from the local filesystem.

```json
{
  "files": [
    { "path": "robots.txt", "sizeBytes": 15 },
    { "path": "snapshot/sitemap.xml", "sizeBytes": 49, "contentType": "text/xml" }
  ]
}
```

Each manifest path is relative to the destination folder. A batch supports up to 256 files and 1 GiB in total. The instance's per-file size limit also applies. The response contains `uploadId`, `expiresAt`, and a `files` array. Each entry contains the submitted `path`, `sizeBytes`, `uploadUrl`, and `headers`. The script sends one `PUT` per entry with the returned `Content-Type`, the file's `Content-Length`, and its original bytes. Both the manifest and the file requests use the signed URLs for access. The script can keep the individual URLs and file contents outside the chat.

The file links expire ten minutes after the manifest succeeds. A file upload at an existing path returns `409`. To resume an incomplete upload, check which files arrived and call `create_upload` with the same `folder` and `uploadId`. Submit only the remaining files. Use `list_folder` to get the IDs and protected links for completed uploads.

Native file references depend on the client. ChatGPT may already have access to a file that you attach to a chat. Select it on the Drop Shelf page or send it directly with an HTTP client to keep the file off ChatGPT. If the instance has not enabled single-use links, use the browser links or an HTTP client with Cloudflare Access authorization.

## Inline uploads

Use `upload_file` when you intend to send the content in the tool call, for example a page generated by an agent. Call `whoami` first:

```json
{
  "name": "upload_file",
  "arguments": {
    "path": "index.html",
    "encoding": "utf8",
    "content": "<!doctype html><html lang=\"en\"><title>Review</title><h1>Ready for review</h1></html>"
  }
}
```

Call `check_uploads` with the full path first. If a file exists, follow the replacement steps below. The upload result contains a file ID, version, verified uploader, and protected browser and download URLs. A link does not grant access to a user who is outside the Access policy.

For a folder:

1. Call `create_upload`.
2. Pass the returned `uploadId` to every `upload_file` call.
3. Use paths such as `report/index.html` and `report/images/chart.png`.
4. Use `utf8` for HTML, SVG, Markdown, CSV, or JSON. Use `base64` for binary files.

The `ALLOWED_FILE_TYPES` Worker variable applies to MCP uploads too. The `upload_file` tool description reports the active setting.

For inline JSON, use a `.json` path and pass the JSON text in `content`. You can set `contentType` to `application/json`. The server also detects it from the extension. The returned URLs serve the original bytes with that media type. Use `type: "application/json"` with `list_files` to find JSON files. The inline limit is 5 MiB after decoding, and the MCP request limit is 8 MiB.

Folders merge by full path across upload groups. HTML can load relative assets added in later groups. Paths are case-sensitive. A file and a folder cannot use the same full path.

Use `list_files` to get the newest files by default. Set `sort` to `newest`, `oldest`, or `name` (A–Z). Date sorting uses the last update time for files and the time moved to Trash for Trash. Name sorting ignores ASCII letter case and uses the file ID to break ties. Pass `nextCursor` as `cursor` on the next call. Keep the same `view`, `q`, `type`, `author`, and `sort` on every page. Start without a cursor when you change the sort order. Use `get_file` with an ID to get one record.

Use `list_folder` to browse by path. For example, `{"folder":"audit/project","sort":"name"}` lists its direct subfolders and files. Omit `folder` to start at the root. Set `recursive: true` to list files in the folder and all its subfolders. File entries include an ID, path, and Access-protected links. Keep the same `folder`, `recursive`, and `sort` values when you pass `nextCursor` as `cursor`.

## Check or change expiry

`get_file`, `list_files`, and `list_folder` return `permanent` and `expiresAt`. The timestamp is in Unix milliseconds. It is the date a file becomes eligible to move to Trash. In Trash, it is the date a file becomes eligible for deletion. A permanent file has `expiresAt: null`. If automatic expiry is disabled, a file can also have `permanent: false` and `expiresAt: null`.

For a folder, `permanent` is true when all its current files are permanent. `permanentCount` and `fileCount` include all active descendants. `expiresAt` is the earliest deadline among them, or null if none has a deadline. Check `permanentForNewFiles` to see whether a new file directly in this folder will inherit a permanent setting. A subfolder can have its own setting.

Call `set_permanent` with one file ID or one relative folder path. For example, `{"folder":"reports/published","permanent":true}` keeps existing and future files under that path. A folder change replaces any settings below it. To restart the 30-day period for one file, send `{"id":"FILE_UUID","permanent":false}`. The tool returns the updated record. Both actions use the same retention rules as the web app.

## Replace an existing file

1. Call `check_uploads` with `paths`, an array of up to 100 full relative paths.
2. If a result contains `existing`, show the user the path and current file details. Ask before replacement.
3. After approval, use the same path and pass `replace: { "id": "CURRENT_FILE_ID", "version": CURRENT_VERSION }` to `create_upload`, `upload_file_reference`, or `upload_file`. If you use the Access-protected batch API directly, send `replaceId` and `replaceVersion` as query parameters.
4. If the tool returns a conflict, read its current file details and ask again. Do not reuse approval for an older version.

For example, after approval of version 1:

```json
{
  "name": "upload_file",
  "arguments": {
    "path": "report/index.html",
    "content": "<h1>Updated report</h1>",
    "replace": { "id": "CURRENT_FILE_ID", "version": 1 }
  }
}
```

Replacement keeps `id`, `uploadId`, `createdAt`, `url`, and `downloadUrl`. It increases `version` and updates `updatedAt`, size, media type, source, and uploader. The old contents remain available until the new upload completes. There is no version history or recovery of replaced contents from Trash. A path conflict without approval leaves the current file unchanged.

The HTTP API has the same rules. Use `POST /api/uploads/check` with `{ "paths": [...] }`, then add `replaceId` and `replaceVersion` to the upload URL only after approval. A conflict response has HTTP status `409` and includes the current file when available.

## Search, filters, and bulk actions

Use `list_files` with `q` to search a file name. Search is case-insensitive for ASCII characters and treats `%`, `_`, and `\` as literal characters. Combine it with `type` and `author`. The filters apply to the full history, including files on later pages.

Call `get_file_filters` with `view: "files"` or `view: "trash"` to get available type and author values and counts. Use `image/*` for all image types, or a MIME type such as `application/pdf`. The author value is the latest uploader's identity ID, as returned by `get_file_filters`.

Call `trash_files`, `restore_files`, or `delete_files_permanently` with an `ids` array of 1 to 10 unique file IDs. Permanent deletion also requires `confirm: true`. Each result has `id`, `ok`, and an error on failure. Retry only failures. For more than 10 files, send separate calls.

There is no delete-everything MCP tool. To empty Trash, first collect all pages into a fixed list of IDs. Confirm that list with the user, then delete it in batches. Files added later must not be included without a new confirmation.

## Trash and permanent deletion

Any approved team member or configured service identity can manage Trash:

1. Call `trash_file` with the file `id`. Content, downloads, and previews stop working.
2. Call `list_files` with `view: "trash"` to list Trash, newest first by Trash date. Use each cursor with the same view.
3. Call `restore_file` with the `id` to keep the original URL and uploader.
4. To remove bytes permanently, call `delete_file_permanently` with the `id` and `confirm: true`. Confirm the user's intent first. Only files already in Trash can be deleted permanently.

`get_file` includes `trashedAt`, `trashedBy`, and `deletionPending`. A pending permanent deletion cannot be restored. Retry `delete_file_permanently` to finish it. Repeated permanent-delete calls for the same file ID are safe.

Automatic expiry uses the same file store for browser and MCP uploads. The default is 30 days from the last completed upload, replacement, or restore, followed by 7 days in Trash. Each instance can change both periods. A top-level folder moves to Trash as one group, based on the latest date among its active files. Opening files and calling read-only tools do not reset the period. Restore starts a full new active period and keeps upload dates and URLs. An hourly server job applies the policy without agent calls. See [automatic expiry](../README.md#automatic-expiry).

Deletion removes the file record and stored bytes. Link reservations, the file ID, and an object-key hash remain. A deleted URL stays inactive. Start a new upload group to reuse a path after Trash or deletion. Restore fails while another active file uses that path; move the active file to Trash first.

## Access-protected batch uploads

Use this method for any permitted file within the instance limit:

1. Call `create_upload`.
2. Use its `uploadUrl` and add a `path` query parameter.
3. Send a `PUT` with the raw file bytes, `Content-Type`, and `Content-Length`.
4. Authenticate the HTTP request with the same Access OAuth token in `Authorization: Bearer ...`.

The API streams the file to R2. The default instance file limit is 100 MiB. The list uses `web` for Access-protected batch HTTP uploads and `mcp` for uploads with single-use links, file references, or inline content.

Example request shape, with credentials supplied by your client:

```http
PUT /api/uploads/UPLOAD_ID?path=report%2Fimage.png
Authorization: Bearer OAUTH_ACCESS_TOKEN
Content-Type: image/png
Content-Length: FILE_SIZE
```

The app and API hostname must be in the same Access application as the MCP endpoint. Token permissions do not extend to unrelated Access applications.

## Agents without a person present

Access service tokens can authenticate unattended agents when the client can send custom headers:

```text
CF-Access-Client-Id: SERVICE_CLIENT_ID
CF-Access-Client-Secret: SERVICE_CLIENT_SECRET
```

Create a Service Auth policy that allows only the intended service token. Configure a display label under `serviceTokenLabels` in the private instance file. Use the token's verified `common_name` claim as the map key. Record this value from your token setup or controlled authentication diagnostics; never use an unverified request header as identity.

```json
{
  "serviceTokenLabels": {
    "VERIFIED_COMMON_NAME": "Build agent"
  }
}
```

Generate the instance configuration again and redeploy both Workers. Service uploads show that label and have no uploader email. They do not claim that a person was authenticated. Keep the client ID and secret in the client's secret store. Do not commit them.

## Local testing

Start the local app, then connect a test client to `http://localhost:8787/mcp`. The local endpoint uses the development identity. Production still requires Access.

The automated tests cover protocol initialization, tool discovery, identity, upload, and reading the stored HTML through its content URL. A real OAuth login must also be tested on the deployed instance.

Run the deployment check with the official MCP client SDK:

```sh
node scripts/check-mcp.mjs https://YOUR_APP_HOST/mcp
```

Open the printed authorization URL in Chrome. The script checks the OAuth challenge, public-client registration, PKCE login, token refresh when issued, tool discovery, identity, and file listing. Tokens stay in memory.

Add `--write` to create test HTML, SVG, Markdown, and CSV files in the instance. That mode also checks relative image paths, protected content URLs, and HTTP uploads with the same verified email. The script uses `127.0.0.1:8990` for its callback. Keep that port free during the check.

Add `--transfer` to upload and download one generated JSON with single-use URLs. The script compares the SHA-256 digests and checks that each link rejects a repeat request. It uses OAuth for MCP and uses the signed URLs alone for the two HTTP transfers.

Add `--batch` to check a 160-file manifest with one MCP upload call. The script uploads and downloads three sample files in the batch, checks their bytes, and verifies folder listing and replay errors.
