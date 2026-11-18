import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../shared/types';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const wrangler = resolve(require.resolve('wrangler/package.json'), '../bin/wrangler.js');

export interface LocalApp {
  appOrigin: string;
  contentOrigin: string;
  config: AppConfig;
  logs: () => string;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local test port.');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export async function startLocalApp(): Promise<LocalApp> {
  const port = await freePort();
  const appOrigin = `http://localhost:${port}`;
  const contentOrigin = `http://127.0.0.1:${port}`;
  const instanceName = `dropshelf-e2e-${randomUUID()}`;
  const appName = `E2E ${instanceName.slice(-8)}`;
  // This template contains only local bindings. Do not load deployment files or .dev.vars.
  const template = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'dropshelf-e2e-'));
  const configPath = join(directory, 'wrangler.json');
  try {
    await writeFile(configPath, JSON.stringify({
      ...template,
      name: instanceName,
      main: relative(directory, resolve(root, 'worker/index.ts')),
      tsconfig: relative(directory, resolve(root, 'tsconfig.worker.json')),
      assets: { ...template.assets, directory: relative(directory, resolve(root, 'dist')) },
      vars: { ...template.vars, APP_NAME: appName, APP_ORIGIN: appOrigin, CONTENT_ORIGIN: contentOrigin,
        TRANSFER_ORIGIN: contentOrigin, TRANSFER_SIGNING_KEY: randomBytes(32).toString('hex') },
    }));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const environment: NodeJS.ProcessEnv = {
    CI: 'true',
    WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    WRANGLER_LOG_PATH: join(directory, 'logs'),
  };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  const child = spawn(process.execPath, [wrangler, 'dev',
    '--config', configPath, '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--inspector-port', '0', '--persist-to', join(directory, 'state'),
    '--show-interactive-dev-session=false', '--log-level', 'warn',
  ], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let output = '';
  const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-24_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let exited = false;
  const closed = new Promise<void>(resolve => {
    child.once('error', error => { append(Buffer.from(error.message)); exited = true; resolve(); });
    child.once('exit', () => { exited = true; resolve(); });
  });
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const onExit = () => kill('SIGKILL');
  process.once('exit', onExit);
  const stop = async () => {
    process.removeListener('exit', onExit);
    kill('SIGTERM');
    await Promise.race([closed, delay(5_000, undefined, { ref: false })]);
    kill('SIGKILL');
    await closed;
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !exited) {
      if (output.includes('[ERROR]')) break;
      try {
        const response = await fetch(`${appOrigin}/api/config`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) {
          const config = await response.json() as AppConfig;
          if (config.name !== appName || config.user.email !== 'e2e@example.test' ||
            config.appOrigin !== appOrigin || config.contentOrigin !== contentOrigin || !config.local) {
            throw new Error('The local server returned an unexpected test identity or configuration.');
          }
          return { appOrigin, contentOrigin, config, logs: () => output, stop };
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('The local server')) throw error;
      }
      await delay(100);
    }
    throw new Error(`The local test Worker did not start.\n${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
