# Security model

## Trash access

Any identity approved by Access can move, restore, or permanently delete team files. The Worker records who moved a file to Trash from the verified identity. Files in Trash do not serve content, downloads, or thumbnails. No R2 object is removed by the move or restore action.

Permanent deletion requires a file already in Trash and an explicit `confirm: true` request. A deletion state blocks concurrent restore before bytes are removed. R2 deletion happens before transactional D1 cleanup. If either service fails, the operation can be retried without restoring a file whose bytes may be gone. Only a file ID and object-path hash remain after completion, so a delayed retry cannot remove a replacement file.

## Identity and access

Cloudflare Access protects both instance hostnames. The Worker independently validates the Access JWT with the configured team's public keys. It checks the issuer, audience, signature algorithm, required timestamps, and expiry. A plain email header is not trusted.

Upload groups belong to the verified user or service. One user cannot add a file to another user's upload group. Every file stores the identity used at upload time. An email is a historical record; changing an Access policy does not rewrite old uploader records.

All approved identities can list and read all ready files within an instance. Use separate instances for teams that must not share data. Each instance needs separate R2, D1, and Access resources.

The deployment guide uses a 14-day browser session, a 15-minute MCP access token, and a 14-day OAuth refresh grant. Cloudflare Access manages all three. Daily use does not remove the grant's time limit. A client can refresh only while its grant remains valid and its identity passes Access policy checks. See [session and renewal setup](mcp.md#session-duration-and-renewal).

Use Access to change or revoke access. Do not rely on a policy edit to invalidate every token already issued at once. Existing tokens can remain valid until expiry or revocation. Keep the browser cookie HttpOnly and restrict OAuth return addresses to the clients used by the instance.

## Uploaded HTML and SVG

Uploaded content must use a different origin from the app. The content origin serves file bytes only. It exposes no file list, upload API, app assets, or MCP tools. The app origin does not serve uploaded HTML or SVG, including through image preview endpoints.

File responses use `X-Content-Type-Options: nosniff`, a private no-store cache policy, and a content security policy. The policy allows inline page scripts and styles, relative images, and HTTPS display resources. It blocks `fetch` and other API connections, form submission, plugins, and framing. This protects the application while allowing useful static HTML reviews. It is not an anonymous malware analysis sandbox.

HTML that needs network API calls needs a deliberate policy change. Assess that change for your instance before you relax the content policy. Keep the separate origins and server origin checks.

The `ALLOWED_FILE_TYPES` Worker variable controls new uploads. Both the client and server enforce it. Known extensions set the canonical media type, so a client cannot label a known HTML or Markdown file as an image to bypass an image-only setting. For unknown formats, the supplied media type can match a configured MIME pattern. This is an upload policy, not a file-content scanner.

The app stores the original bytes. It does not scan files for malware, convert image formats, or guarantee that an image decoder accepts a file. A raster preview is optional. Markdown and CSV previews use `text/plain` so their contents display as text. Treat files as content from team members.

## Requests and storage

Browser API and MCP requests with a foreign Origin are rejected. Non-browser MCP clients can omit Origin after Access authentication. The API rejects cross-site browser requests. Size limits apply before the Worker buffers JSON, and raw HTTP uploads use a fixed-length stream to R2.

File paths must be relative. Empty parts, traversal parts, control characters, and backslashes are rejected. R2 keys include a random upload ID. A database uniqueness constraint reserves each path before R2 is written, so a concurrent request cannot overwrite an existing file in that upload group.

R2 stays private. The browser and MCP receive Worker URLs, not public bucket URLs or storage credentials. The file list contains only records whose object write and database update completed. Failed writes are removed where possible and remain invisible otherwise.

## Local development

The checked-in configuration uses an explicit test email on loopback addresses only. The production setup script clears this email, requires HTTPS origins, requires separate origins, and checks the Access configuration. Unexpected hostnames are rejected. Worker preview URLs are disabled by the production configuration.

## Configuration and secrets

Instance files and generated deployment configuration live outside the source repository. Account IDs, audiences, hostnames, and service display mappings are deployment data. OAuth login credentials stay in Wrangler's auth profile. Service token secrets belong in the client secret store.

There is no user password database, application session key, or shared user MCP API key in this project. Access owns user login and token lifecycle.
