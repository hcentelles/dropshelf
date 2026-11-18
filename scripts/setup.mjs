import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ALLOWED_FILE_TYPES, parseAllowedFileTypes } from '../shared/formats.ts';
import { DEFAULT_FILE_RETENTION_DAYS, DEFAULT_TRASH_RETENTION_DAYS, parseRetentionDays } from '../shared/retention.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argument(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
const help = `Create instance configuration outside the repository.

Usage:
  npm run setup -- --input /absolute/path/instance.json --out /absolute/path/config

Copy instance.example.json to a private directory and replace its example values.
Create R2 and an Access application first. See docs/deployment.md.
`;
if (args.includes('--help')) { console.log(help); process.exit(0); }
const inputPath = argument('input');
const outputPath = argument('out');
if (!inputPath || !outputPath) { console.error(help); process.exit(1); }

function outsideProject(path) {
  if (!isAbsolute(path)) throw new Error('Use absolute input and output paths.');
  const location = relative(root, resolve(path));
  if (!location.startsWith('..') && !isAbsolute(location)) {
    throw new Error('Keep instance configuration outside the repository.');
  }
}
function requireString(config, field, pattern) {
  const value = config[field];
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value))) {
    throw new Error(`The ${field} value is not valid.`);
  }
  return value;
}
function origin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Production origins must be HTTPS origins with no path.');
  }
  return url.origin;
}

try {
  outsideProject(inputPath);
  outsideProject(outputPath);
  const config = JSON.parse(await readFile(inputPath, 'utf8'));
  const name = requireString(config, 'name', /^[a-z][a-z0-9-]{0,43}$/);
  const accountId = requireString(config, 'accountId', /^[a-f0-9]{32}$/);
  const bucket = requireString(config, 'bucket', /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/);
  const appOrigin = origin(requireString(config, 'appOrigin'));
  const contentOrigin = origin(requireString(config, 'contentOrigin'));
  if (appOrigin === contentOrigin) throw new Error('Use separate app and content origins.');
  const teamDomain = requireString(config, 'accessTeamDomain', /^[a-z0-9-]+\.cloudflareaccess\.com$/);
  const aud = requireString(config, 'accessAud', /^[a-f0-9]{64}$/);
  const maxBytes = config.maxFileBytes ?? 104857600;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 104857600) throw new Error('Use a file limit from 1 byte to 100 MiB.');
  const allowed = parseAllowedFileTypes(config.allowedFileTypes ?? DEFAULT_ALLOWED_FILE_TYPES).join(',');
  const fileDays = parseRetentionDays(config.fileRetentionDays ?? DEFAULT_FILE_RETENTION_DAYS, 'fileRetentionDays');
  const trashDays = parseRetentionDays(config.trashRetentionDays ?? DEFAULT_TRASH_RETENTION_DAYS, 'trashRetentionDays');
  const appName = config.appName ?? 'Drop Shelf';
  if (typeof appName !== 'string' || !appName.trim() || appName.length > 100) throw new Error('The appName value is not valid.');
  const labels = config.serviceTokenLabels ?? {};
  if (!labels || Array.isArray(labels) || typeof labels !== 'object' ||
    Object.values(labels).some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('Service token labels must be a map of identity names to display labels.');
  }
  const common = {
    account_id: accountId,
    main: resolve(root, 'worker/index.ts'),
    compatibility_date: '2026-10-28',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    preview_urls: false,
    assets: { directory: resolve(root, 'dist'), binding: 'ASSETS', run_worker_first: true },
    observability: { enabled: true, head_sampling_rate: 0.1 },
    vars: {
      APP_NAME: appName, APP_ORIGIN: appOrigin, CONTENT_ORIGIN: contentOrigin,
      ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud, LOCAL_DEV_EMAIL: '',
      SERVICE_TOKEN_LABELS: JSON.stringify(labels), MAX_FILE_BYTES: String(maxBytes),
      ALLOWED_FILE_TYPES: allowed,
      FILE_RETENTION_DAYS: String(fileDays), TRASH_RETENTION_DAYS: String(trashDays),
    },
    r2_buckets: [{ binding: 'FILES', bucket_name: bucket }],
  };
  for (const [file, workerName] of [['app.jsonc', name], ['content.jsonc', `${name}-content`]]) {
    const path = resolve(outputPath, file);
    const store = file === 'app.jsonc' ? {
      triggers: { crons: ['0 * * * *'] },
      durable_objects: { bindings: [{ name: 'SHELF', class_name: 'Shelf' }] },
      exports: { Shelf: { type: 'durable-object', storage: 'sqlite' } },
    } : {
      main: resolve(root, 'worker/content-worker.ts'),
      durable_objects: { bindings: [{ name: 'SHELF', class_name: 'Shelf', script_name: name }] },
      // A transfer URL contains a credential. Keep application logs and omit invocation URLs.
      observability: { ...common.observability, logs: { enabled: true, invocation_logs: false } },
    };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify({ ...common, ...store, name: workerName }, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(`Instance configuration created in ${resolve(outputPath)}.`);
  console.log('The two Workers share R2 and one SQLite Durable Object. Access must protect both hostnames.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The configuration could not be created.');
  process.exit(1);
}
