# Deployment

This guide creates one private instance. Repeat it with different names, resources, and account settings for each team. No company settings or credentials belong in the source repository.

## 1. Install and authenticate

Install Node.js 24 or later, clone the repository, and run:

```sh
npm ci
npm run build
```

For a computer with more than one Cloudflare account, create a named Wrangler profile:

```sh
npx wrangler auth create shelf-demo
npx wrangler auth activate shelf-demo
```

In Chrome, select only the account for this instance. Do not select access to all accounts. The profile keeps this login separate from the default Wrangler login.

Auth profiles are currently an experimental Wrangler feature. Use `--profile shelf-demo` on the commands below, and set `account_id` through the setup script. These two settings prevent an accidental deployment to another account.

For automated deployments, use a Cloudflare API token restricted to the target account. Store it as `CLOUDFLARE_API_TOKEN` in your deployment system. Wrangler API tokens take precedence over auth profiles. Do not put a token in an instance file.

## 2. Select addresses

Use two HTTPS origins:

- App: `https://dropshelf-demo.YOUR_SUBDOMAIN.workers.dev`
- Content: `https://dropshelf-demo-content.YOUR_SUBDOMAIN.workers.dev`

You can find your Workers subdomain in the account dashboard. The Worker names must match these addresses. A custom-domain setup is described below.

## 3. Create storage

Enable R2 in the target account if needed. Use Standard storage and keep public access disabled. Then create the bucket:

```sh
CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID npx wrangler r2 bucket create dropshelf-demo-files --profile shelf-demo
```

The first app deployment creates the SQLite Durable Object namespace. Its schema is created when the object first starts. The bucket has no public domain and needs no S3 credentials. Workers use native bindings.

## 4. Configure Cloudflare Access

In the target account, open Zero Trust. Enable an appropriate plan if needed. A small instance can use the Free plan within its limits.

1. Open **Integrations → Identity providers**.
2. Add **One-time PIN**.
3. Open **Access controls → Applications** and add a **Self-hosted** application.
4. Add both app and content hostnames as public hostnames in this one application.
5. Add an **Allow** policy with the exact email addresses that can use the instance. Use an email-domain rule only when the whole domain should have access.
6. Enable only the One-time PIN identity provider for this application.
7. In **Application details → Details**, set **Session Duration** to **2 weeks**. Leave the Allow policy's session duration at **Same as application**. Keep the authorization cookie **HttpOnly**.
8. In **Additional settings → Managed OAuth**, enable Managed OAuth and dynamic client registration. Set **Grant session duration** to **2 weeks** and **Access token lifetime** to **15 minutes**. Add the return addresses for your MCP clients. Loopback callbacks are needed by many desktop clients. See [chat client setup](mcp.md#chat-client-setup) for ChatGPT and Claude Chat.
9. Copy the application's **AUD tag** and your Zero Trust team domain, such as `your-team.cloudflareaccess.com`.

The OAuth setting belongs to our Access application. The Worker validates Access JWTs; it does not run a separate OAuth server. This is the [Cloudflare Managed OAuth flow](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

These settings give new browser sessions a 14-day lifetime. MCP clients can use a refresh token to renew their 15-minute access token within a 14-day grant. Daily use does not make the grant last forever. When it ends, Access requires authorization again. A valid Access login can reduce the sign-in steps. See [session behavior](mcp.md#session-duration-and-renewal).

For an API-managed instance, the application fields are `session_duration: "336h"`, `oauth_configuration.grant.session_duration: "336h"`, and `oauth_configuration.grant.access_token_lifetime: "15m"`. Read the current application before an update and preserve its other settings, including policies, hostnames, identity providers, and client return addresses. Do not change the account-wide session duration for this instance.

Use one Access application for both hostnames so one OAuth token can reach the app API and content URLs. Keep the default cookie setup that signs browser users into all application hostnames. If you use separate Access applications, you must configure their audiences and delegated access separately; this setup script expects one audience.

Do not add a Bypass or Everyone policy. Do not expose the R2 bucket. The Worker also fails closed if Access is missing or misconfigured.

## 5. Prepare Worker environment variables

All runtime settings are environment variables or secrets on the Cloudflare Workers. The app reads them through `env`. You can manage them in **Worker → Settings → Variables and Secrets**. Keep shared values consistent on both Workers. The private JSON file below prepares the deployment variables; it is not a runtime configuration store. Keep it in sync with dashboard changes before a later deployment. Store credentials as Worker secrets.

Copy `instance.example.json` to a private directory outside the checkout. For example:

```sh
mkdir -p "$HOME/.config/dropshelf/demo"
cp instance.example.json "$HOME/.config/dropshelf/demo/instance.json"
```

Edit that copied file. Set the account ID, bucket, exact app and content origins, Access team domain, and AUD tag. Change `appName` to set the name shown in the UI. Set `allowedFileTypes` to the allowed extensions and MIME types, such as `image/*,.html,.htm,.md,.markdown,.csv,.pdf,.css,.js,.zip`. This becomes the `ALLOWED_FILE_TYPES` Worker variable. The two Worker names are `name` and `name-content`.

Set `fileRetentionDays` and `trashRetentionDays` for automatic expiry. The defaults are `30` and `7`. Use whole days from `1` to `36500`, or `0` to disable either step. These values become `FILE_RETENTION_DAYS` and `TRASH_RETENTION_DAYS`. A root file or top-level folder moves to Trash after the first period. Files are deleted after the second period starts at the move to Trash. See [automatic expiry](../README.md#automatic-expiry) for folder and restore rules.

Generate deployment files:

```sh
npm run setup -- --input "$HOME/.config/dropshelf/demo/instance.json" --out "$HOME/.config/dropshelf/demo"
```

This creates `app.jsonc` and `content.jsonc`. Both point to the local source and built assets. The app configuration defines the SQLite Durable Object. The content configuration binds to that object in the app Worker. They contain deployment settings, and they stay outside Git. They clear the local test identity and disable Worker preview URLs.

Only the app configuration has the hourly Cron Trigger, `0 * * * *`. The content Worker does not need its own schedule. Keep schedule changes in the generated app configuration or setup script. Cloudflare can take up to 15 minutes to apply a schedule change. See [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## 6. Deploy

```sh
npm run check
npx wrangler deploy --config "$HOME/.config/dropshelf/demo/app.jsonc" --profile shelf-demo
npx wrangler deploy --config "$HOME/.config/dropshelf/demo/content.jsonc" --profile shelf-demo
```

Deploy the app first so its Durable Object namespace exists before the content Worker is deployed. The Workers share storage and the file service. The app origin serves the UI, API, and MCP. The content origin serves only uploaded files. Access protects both.

If Access does not show a login page on a `workers.dev` address, review that Worker's **Settings → Domains & Routes → Cloudflare Access** and the Access application hostname list. Do not relax the Worker token check to work around a routing error.

## 7. Verify

Check the complete flow before you invite the team:

1. In a browser without a session, open the app and a copied file URL. Both must require Access login.
2. Sign in with an approved email code. The app header must show the email handle.
3. Drop HTML, an image, and an unsupported file. Check the accepted and skipped counts.
4. Open the HTML and image links. Check the uploader and date in the list.
5. Upload a folder with `index.html`, a relative image, CSS, and JavaScript. Open each folder level. Open the HTML and verify its assets and script.
6. Copy one link and the links from a completed upload.
7. Check newest, oldest, and name sorting in Files and Trash. Load more files and verify that pages do not repeat or skip entries.
8. Connect your MCP client using OAuth. Call `whoami`, upload a file, and verify the same handle in the browser list.
9. Confirm that an unapproved email cannot pass the Access policy.
10. Confirm that the content hostname returns no UI, file list, or MCP tools.
11. Open two app pages. Add a file through the browser and MCP. Check that both pages update. Move, restore, and delete a test file, then check the other page without a refresh. Disconnect and reconnect the network, and check that the page recovers.
12. In each chat client, repeat a live `whoami` call at least 16 minutes after the initial OAuth connection. Do not reconnect between calls. Check the tool result, not only the model's answer. See the [renewal test](mcp.md#test-renewal-in-a-chat-client).

A plain HTTP check is useful for the OAuth challenge:

```sh
curl -i -H 'Accept: application/json' https://YOUR_APP_HOST/mcp
```

With Managed OAuth active, Access should return a `401` with an OAuth `WWW-Authenticate` discovery header. This check does not replace a real client login.

## Custom domains

Add separate custom domains to the two Workers in the dashboard. Update the two origins in the private instance file, add both hostnames to the Access application, generate the configuration again, and redeploy both Workers.

The generated configuration keeps `workers.dev` enabled. The Worker rejects any hostname that differs from the two configured origins, so an older default URL cannot expose the app or files. You can also disable `workers.dev` in the instance's generated configuration after custom domains are ready.

## Updates and operations

Keep the same R2 bucket, app Worker name, Durable Object class (`Shelf`), and object name (`default`) when you deploy a new code version. The object name is fixed so a hostname change does not create an empty shelf. Schema changes belong in the versioned initialization in `worker/schema.ts`; they run in a synchronous SQLite transaction. Generate configuration again if you move the checkout, because its source paths are absolute.

For an existing Durable Object instance, the folder merge update preserves file records and URLs. Schema version 2 adds shared paths and replacement records. If older groups contain the same active file path, the first file keeps its name and later copies get a ` (copy 2)` suffix or the next free number. All original links and bytes stay available. Deploy the app Worker first, then the content Worker.

Schema version 3 adds the restore date used for expiry. Existing upload and Trash dates stay unchanged. Before enabling expiry, review both periods: they apply to existing files and Trash. Generate the instance configuration again to add the retention variables and hourly schedule. Missing retention variables disable the corresponding step; invalid values stop the job. Changing a period does not reset file dates.

Schema version 4 adds file and folder expiry settings. Existing files continue to use their current default until a team member selects **Reset to 30 days** or **Make permanent**. Folder settings cover all descendants and future uploads. No new Worker variables or storage bindings are required. Deploy the app Worker first, then the content Worker.

The earlier move from D1 to Durable Objects did not copy D1 records or remove old resources. An instance still using D1 needs a separate migration for any data it must keep.

Check file name search, type and author filters, and selection across pages. Check that **Delete all** shows the full Trash count when filters hide files. Do not confirm this action against files you need.

Test the full Trash flow with a disposable sample file: move it to Trash, check that its content URL returns `404`, restore it and check the same URL, then confirm permanent deletion from Trash. The last step removes the sample's stored bytes.

Use Durable Object SQLite point-in-time recovery for metadata recovery. See [Cloudflare storage recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#point-in-time-recovery-api). Keep a separate R2 backup if your team needs recoverable file copies. A metadata backup alone does not contain file bytes. Recovery must keep the metadata and R2 contents consistent.

New uploads use write reservations that expire after 30 minutes. A Durable Object alarm removes expired reservations and retired objects. Completed writes keep a receipt for 24 hours to handle a lost response. Ready file records are the file list's source of truth. Check older incomplete records or orphan objects before removal; never remove objects linked to ready records. Replaced contents are not a backup and cannot be recovered from Trash.

The app Worker checks expiry every hour. The job moves each due root file or top-level folder to Trash, then claims up to 100 due Trash files for permanent deletion. It also retries pending deletions. A larger backlog requires more runs. Check the `retention_completed` log counts (`trashed`, `deleted`, and `failed`) and the Cron Trigger event status. A deletion failure makes the scheduled event fail after it attempts the remaining files in that batch.

If permanent deletion starts but R2 or the metadata update fails, the file stays pending in Trash and cannot be restored. The next scheduled run retries it, even if the automatic deletion period was disabled after deletion started. A manual retry also works. Do not clear that state manually: the stored bytes may already be gone. A metadata backup cannot restore bytes removed from R2.

For a local schedule check, run `npm run dev -- --test-scheduled`, then request `http://localhost:8787/cdn-cgi/local/scheduled?cron=0+*+*+*+*`. This runs against the local shelf. Do not add an HTTP cleanup endpoint to the deployed app.

To end an instance, first remove team access. Export data you need, then remove only that instance's Workers and resources. Shared resources from other instances must stay separate.
