# Local tests

Use Node.js 24 or later. From the repository root, install dependencies and Chromium:

```sh
npm ci
npm run test:e2e:install
```

On a Linux machine that lacks browser system libraries, use `npx playwright install --with-deps chromium`. Dependency and browser installation need internet access. The tests use local services only.

## Commands

| Command | Checks |
| --- | --- |
| `npm run lint` | JavaScript and TypeScript correctness rules through Oxlint |
| `npm test` | Unit and integration tests inside the Workers runtime |
| `npm run test:e2e` | Build the UI, then run browser and MCP end-to-end tests |
| `npm run test:e2e:web` | Build the UI, then run Chromium tests |
| `npm run test:e2e:mcp` | Build the UI, then run MCP SDK tests over local HTTP |
| `npm run check` | Lint, TypeScript, UI build, runtime tests, and both end-to-end suites |
| `npm run test:e2e:report` | Open the last HTML test report |

Pass Playwright options after `--`:

```sh
npm run test:e2e -- --project=web --headed
npm run test:e2e -- --project=web --grep 'replacement'
npm run test:e2e -- --project=mcp --workers=1
npm run test:e2e -- --repeat-each=2
npm run test:e2e -- --project=web --ui
```

The runner builds once before the tests. In Playwright UI mode, exit and run the command again after a source change to rebuild the app.

## GitHub Actions

The `Check` workflow in `.github/workflows/check.yml` runs on every push and pull request, with no branch or path filters. You can also start it from the Actions page. A new run cancels an older run for the same event and branch.

The job uses Ubuntu 24.04, Node.js 24, and `npm ci`. It runs lint, TypeScript checks, the production UI build, unit and Worker integration tests, a production dependency audit, and both Playwright projects. It installs Chromium and its Linux libraries before E2E tests start.

Oxlint checks the JavaScript and TypeScript source, scripts, and tests. It follows `.gitignore` and excludes generated Worker declarations. Warnings fail the check. TypeScript remains responsible for type checks.

E2E tests use the same fixtures and temporary local R2 and SQLite storage as local runs. Each test worker starts its own local server. The workflow needs no Cloudflare account, deployment secrets, or existing shelf. Its GitHub token has read-only repository access. Actions are pinned to commit IDs.

The E2E suite has a five-minute total limit. The job has a fifteen-minute limit, which leaves time for installation and report upload. Normal teardown removes test storage. The hosted runner is discarded after the job.

Download the `playwright-results` artifact from a run to inspect its HTML report, traces, failure screenshots, and Worker output. Reports are uploaded after success or failure and retained for seven days. Cancelled runs can end before report upload.

## Local services and isolation

`playwright.config.ts` defines separate `web` and `mcp` projects. Both use the fixtures in `e2e/fixtures.ts`.

Each Playwright worker starts a Wrangler process with `--local`. It gets a free loopback port and a new temporary directory. Its configuration comes from `e2e/wrangler.jsonc`. The test server uses the real app entry point, built UI, file service, MCP handler, R2 simulator, and SQLite Durable Object.

The app uses `http://localhost:<port>`. Uploaded content uses `http://127.0.0.1:<port>`. The two browser origins stay separate. This is the same local arrangement as `npm run dev`.

The test configuration uses `e2e@example.test`, a 1 MiB file limit, 30 days before Trash, and 7 days in Trash. It has no account ID or remote binding. The process starts from its temporary directory, without deployment configuration, `.dev.vars`, `.env`, or inherited credentials. Browser requests to any other origin fail the test.

The runner does not use the shelf at port 8787 or its `.wrangler/state` directory. Each test clears active files and Trash through the normal HTTP API. Each browser test also gets a new browser context. Worker teardown stops the process and removes its temporary storage, including after a test failure.

Tests have no automatic retries. Each test can run alone or in parallel. Two workers run by default. Use `--workers=1` on a machine with limited memory.

## Fixtures

All tests import `test` and `expect` from `e2e/fixtures.ts`.

| Fixture | Purpose |
| --- | --- |
| `app` | Local server, app URL, content URL, and current configuration |
| `shelf` | Empty shelf, HTTP client, upload helper, and paginated file reads |
| `seed` | Load the fixed sample data and return its file records |
| `page` | Chromium page with script-error checks and local request limits |
| `mcp` | Connected MCP client SDK with JSON result helpers |

`seed` is optional. Tests that do not request it start with no files. The seed adds `alpha.md`, `zulu.csv`, a `site` folder, and `discarded.md` in Trash. The site contains HTML, external CSS and JavaScript, an SVG image, and nested Markdown. The folder-picker test uses `unsupported.bin` as its excluded file.

Fixture files are in `e2e/fixtures/`. Upload IDs, file IDs, and dates come from the running server. Tests use the returned records instead of fixed database IDs. ZIP fixtures are generated locally with a fixed file date. No production data or test-only reset API is required.

To add a test:

```ts
import { test, expect } from './fixtures';

test('shows a seeded file', async ({ page, app, seed }) => {
  await page.goto(app.appOrigin);
  await expect(page.getByRole('link', { name: seed.alpha.name, exact: true })).toBeVisible();
});
```

## Failure reports

The terminal shows failed assertions. `playwright-report/` contains the HTML report. `test-results/` contains failure screenshots, traces, and captured Worker output. Both directories are excluded from Git.

Use `npm run test:e2e:report` to inspect a failure. The report can open a trace with browser actions, network requests, and page snapshots. Worker output is attached to failed tests. Browser and file-service responses are real; the suite does not replace them with mock responses.

## Coverage limits

The local tests use the loopback development identity. They do not test the hosted Cloudflare Access login, Managed OAuth, production routing, or the deployed cross-Worker binding. The MCP tests use the real client SDK and Streamable HTTP transport, with no OAuth login.

The Workers runtime tests cover Access token validation, expiry timing, storage failures, and other server edge cases. The browser tests check the expiry tooltip and Trash countdown. The [deployment guide](deployment.md) describes the separate live checks.
