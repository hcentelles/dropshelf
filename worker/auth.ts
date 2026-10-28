import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Principal } from '../shared/types';
import { HttpError, isLoopback } from './http';

const keySets = new Map<string, JWTVerifyGetKey>();

export async function authenticate(
  request: Request, env: Env, getKey?: JWTVerifyGetKey,
): Promise<Principal> {
  const url = new URL(request.url);
  if (isLoopback(url.hostname) && env.LOCAL_DEV_EMAIL) {
    return { id: 'local-developer', email: env.LOCAL_DEV_EMAIL, label: env.LOCAL_DEV_EMAIL, kind: 'user' };
  }
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) || !env.ACCESS_AUD) {
    throw new HttpError(503, 'Cloudflare Access is not configured.');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new HttpError(401, 'Sign in through Cloudflare Access.');
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let key = getKey ?? keySets.get(issuer);
  if (!key) {
    key = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, key);
  }
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(token, key, {
      issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'iat'],
    }));
  } catch { throw new HttpError(401, 'The Access session is not valid. Sign in again.'); }
  if (typeof claims.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(claims.email) && claims.sub) {
    const email = claims.email.toLowerCase();
    return { id: `user:${claims.sub}`, email, label: email, kind: 'user' };
  }
  if (typeof claims.common_name === 'string') {
    let labels: Record<string, unknown>;
    try { labels = JSON.parse(env.SERVICE_TOKEN_LABELS); }
    catch { throw new HttpError(503, 'The service identity configuration is not valid.'); }
    const label = labels[claims.common_name];
    if (typeof label === 'string' && label.trim()) {
      return { id: `service:${claims.common_name}`, email: null, label: label.trim(), kind: 'service' };
    }
  }
  throw new HttpError(403, 'This identity does not have an email or a configured service label.');
}
