# Remote MCP

The endpoint is `https://YOUR_APP_HOST/mcp`. It supports the Streamable HTTP transport. It uses the same file service, storage, and identity checks as the browser API.

## User authentication

Enable Access Managed OAuth on the self-hosted application. Add the remote URL in an MCP client that supports OAuth resource indicators (RFC 8707). The client opens a browser, the user enters the email code, and Access issues an OAuth token.

Access resolves the client token and sends a signed JWT to the Worker in `Cf-Access-Jwt-Assertion`. The Worker verifies its signature, issuer, audience, and expiry. It then reads the user's email. The uploader email cannot be set in tool arguments.

An OAuth token is not the Access JWT. Do not decode the opaque OAuth token or pass it as `Cf-Access-Jwt-Assertion`. Access handles that step.

Managed OAuth is currently in beta. Test your clients before team rollout. A normal browser cookie login by itself does not prove that an MCP client can authenticate.

## Tools

Call `whoami` first. Then upload a simple page:

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

The result contains a file ID, verified uploader, and protected browser and download URLs. A link does not grant access to a user who is outside the Access policy.

For a folder:

1. Call `create_upload`.
2. Pass the returned `uploadId` to every `upload_file` call.
3. Use paths such as `report/index.html` and `report/images/chart.png`.
4. Use `utf8` for HTML, SVG, Markdown, or CSV. Use `base64` for binary files.

The `ALLOWED_FILE_TYPES` Worker variable applies to MCP uploads too. The `upload_file` tool description reports the active setting.

Use `list_files` to get the newest files. Pass its `nextCursor` as `cursor` on the next call. Use `get_file` with an ID to get one record.

## Larger files

An inline MCP file can be at most 5 MiB after decoding. The MCP request limit is 8 MiB. For a larger file within the instance limit:

1. Call `create_upload`.
2. Use its `uploadUrl` and add a `path` query parameter.
3. Send a `PUT` with the raw file bytes, `Content-Type`, and `Content-Length`.
4. Authenticate the HTTP request with the same Access OAuth token in `Authorization: Bearer ...`.

The API streams the file to R2. The default instance file limit is 25 MiB. The list uses `web` for HTTP uploads and `mcp` for inline MCP uploads.

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
