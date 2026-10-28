import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticate } from '../worker/auth';

const team = 'test-team.cloudflareaccess.com';
const audience = 'test-audience';
const authEnv = { ...env, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience, LOCAL_DEV_EMAIL: '' };
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let key: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  pair = await generateKeyPair('RS256');
  key = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test-key' }] });
});

async function token(options: { audience?: string; issuer?: string; expires?: string; email?: string; service?: string } = {}): Promise<string> {
  return new SignJWT(options.service ? { common_name: options.service } : { email: options.email ?? 'member@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setSubject('user-123')
    .setIssuer(options.issuer ?? `https://${team}`).setAudience(options.audience ?? audience)
    .setIssuedAt().setExpirationTime(options.expires ?? '1h').sign(pair.privateKey);
}
function request(jwt?: string): Request {
  return new Request('https://shelf.example.test/api/config', { headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} });
}

describe('Access identity verification', () => {
  it('reads the email from a signed token', async () => {
    expect(await authenticate(request(await token()), authEnv, key)).toMatchObject({
      id: 'user:user-123', email: 'member@example.test', kind: 'user',
    });
  });
  it('rejects a missing, forged, expired, wrong-audience, or wrong-issuer token', async () => {
    for (const jwt of [undefined, 'forged', await token({ expires: '-1h' }),
      await token({ audience: 'another-app' }), await token({ issuer: 'https://another-team.cloudflareaccess.com' })]) {
      await expect(authenticate(request(jwt), authEnv, key)).rejects.toMatchObject({ status: 401 });
    }
  });
  it('does not accept an email header as identity', async () => {
    const req = request();
    req.headers.set('Cf-Access-Authenticated-User-Email', 'owner@example.test');
    await expect(authenticate(req, authEnv, key)).rejects.toMatchObject({ status: 401 });
  });
  it('requires a configured label for a machine identity and does not invent an email', async () => {
    const jwt = await token({ service: 'service-token-id' });
    await expect(authenticate(request(jwt), authEnv, key)).rejects.toMatchObject({ status: 403 });
    const serviceEnv = { ...authEnv, SERVICE_TOKEN_LABELS: JSON.stringify({ 'service-token-id': 'Build agent' }) };
    expect(await authenticate(request(jwt), serviceEnv, key)).toEqual({
      id: 'service:service-token-id', email: null, label: 'Build agent', kind: 'service',
    });
  });
  it('never enables the local identity on an external hostname', async () => {
    await expect(authenticate(request(), { ...authEnv, LOCAL_DEV_EMAIL: 'developer@example.test' }, key))
      .rejects.toMatchObject({ status: 401 });
  });
});
