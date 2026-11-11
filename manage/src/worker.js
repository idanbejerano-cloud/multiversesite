// The management app's Worker (multiverse-manage.multiversesite.workers.dev).
//
// - Serves the app's files (packed into ./assets.js by ../bundle.mjs).
// - /api/gh/...  forwards requests to the GitHub API for the site's repository only, with the
//   GITHUB_TOKEN secret, so nobody has to keep a GitHub key on their phone.
// - /api/gc/...  forwards statistics requests to GoatCounter with the GOATCOUNTER_API_KEY secret.
// - /api/me      who is signed in.
//
// Who may use the API is decided by Cloudflare Access (sign-in with an email code, for the
// addresses in the Access policy). Every /api request must carry an identity that Access vouched
// for: ctx.access (Workers' built-in Access support), or, as a fallback, the Cf-Access-Jwt-Assertion
// token checked against ACCESS_TEAM_DOMAIN and ACCESS_AUD. Without one of those the API refuses,
// so turning Access off can never open the site's repository to the world.

import ASSETS from './assets.js';

const OWNER = 'idanbejerano-cloud';
const REPO = 'multiversesite';
const GC_API = 'https://multiversesite.goatcounter.com/api/v0';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob: https:; "
  + "connect-src 'self' https://multiversesite.com; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; "
  + "base-uri 'none'; form-action 'none'; object-src 'none'";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, ctx, url);
      } catch (e) {
        return json(502, { error: 'upstream', message: String((e && e.message) || e) });
      }
    }
    return asset(request, url);
  },
};

// ------------------------------------------------------------------ app files
const decoded = new Map();
function bytesOf(path) {
  if (!decoded.has(path)) {
    const bin = atob(ASSETS[path][1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    decoded.set(path, out);
  }
  return decoded.get(path);
}

function asset(request, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: SECURITY_HEADERS });
  let path = url.pathname;
  if (path.endsWith('/')) path += 'index.html';
  const file = ASSETS[path];
  if (!file) return new Response('Not found', { status: 404, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
  const [type, , etag] = file;
  const longLived = /^\/(icons|fonts)\//.test(path);
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    ETag: etag,
    'Cache-Control': longLived ? 'public, max-age=604800' : 'no-cache',
  };
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
  if (path === '/sw.js') headers['Service-Worker-Allowed'] = '/';
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : bytesOf(path), { status: 200, headers });
}

// ------------------------------------------------------------------ API
function json(status, data) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function api(request, env, ctx, url) {
  const who = await identity(request, env, ctx);
  if (!who.ok) return json(401, { error: who.error });
  const sub = url.pathname.slice('/api'.length);

  if (sub === '/me') {
    return json(200, {
      email: who.email, name: who.name,
      ready: { github: Boolean(env.GITHUB_TOKEN), stats: Boolean(env.GOATCOUNTER_API_KEY) },
    });
  }

  if (sub.startsWith('/gh/')) {
    if (!env.GITHUB_TOKEN) return json(503, { error: 'no_github_token' });
    const path = sub.slice('/gh'.length);
    const repoPath = `/repos/${OWNER}/${REPO}`;
    if (!(path === repoPath || path.startsWith(repoPath + '/'))) return json(403, { error: 'path_not_allowed' });
    if (!['GET', 'POST', 'PATCH'].includes(request.method)) return json(405, { error: 'method_not_allowed' });
    const headers = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: request.headers.get('Accept') || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'multiverse-manage',
    };
    let body;
    if (request.method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      body = await request.text();
    }
    const res = await fetch('https://api.github.com' + path + url.search, { method: request.method, headers, body, redirect: 'follow' });
    return passThrough(res);
  }

  if (sub.startsWith('/gc/')) {
    if (!env.GOATCOUNTER_API_KEY) return json(503, { error: 'no_stats_key' });
    const path = sub.slice('/gc'.length);
    if (request.method !== 'GET' || !(path === '/me' || path.startsWith('/stats/'))) return json(403, { error: 'path_not_allowed' });
    const res = await fetch(GC_API + path + url.search, {
      headers: { Authorization: `Bearer ${env.GOATCOUNTER_API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': 'multiverse-manage' },
    });
    return passThrough(res);
  }

  return json(404, { error: 'not_found' });
}

function passThrough(res) {
  const headers = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' };
  const type = res.headers.get('Content-Type');
  if (type) headers['Content-Type'] = type;
  return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers });
}

// ------------------------------------------------------------------ who is signed in
async function identity(request, env, ctx) {
  if (ctx && ctx.access) {
    let id = null;
    try { id = await ctx.access.getIdentity(); } catch { id = null; }
    return { ok: true, email: (id && id.email) || '', name: (id && id.name) || '' };
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return { ok: false, error: 'no_access' };
  const team = String(env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = String(env.ACCESS_AUD || '').trim();
  if (!team || !aud) return { ok: false, error: 'access_needs_config' };
  try {
    const claims = await verifyAccessJwt(token, team, aud);
    return { ok: true, email: claims.email || '', name: claims.name || '' };
  } catch {
    return { ok: false, error: 'bad_access_token' };
  }
}

const b64url = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};

let certCache = { team: '', at: 0, keys: [] };
async function accessKeys(team, refresh = false) {
  if (!refresh && certCache.team === team && Date.now() - certCache.at < 3600e3 && certCache.keys.length) return certCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('certs ' + res.status);
  const keys = (await res.json()).keys || [];
  certCache = { team, at: Date.now(), keys };
  return keys;
}

export async function verifyAccessJwt(token, team, aud) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const dec = new TextDecoder();
  const header = JSON.parse(dec.decode(b64url(parts[0])));
  const claims = JSON.parse(dec.decode(b64url(parts[1])));
  if (header.alg !== 'RS256') throw new Error('alg');
  let jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await accessKeys(team, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('kid');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('signature');
  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new Error('aud');
  if (claims.iss !== `https://${team}`) throw new Error('iss');
  if (typeof claims.exp !== 'number' || claims.exp < now - 30) throw new Error('expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + 30) throw new Error('nbf');
  return claims;
}
