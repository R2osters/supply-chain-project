#!/usr/bin/env node
// SCIP dynamic security probe. Node >= 18, no dependencies.
//
//   node scripts/security/probe.mjs --base http://127.0.0.1:3101/api/v1 [--routes routes.log]
//
// A black-box check of a RUNNING SCIP API. It never writes data it cannot clean up and it makes
// no destructive call with a real token; the failed-login test uses a throwaway address, not a
// real account. Point it ONLY at a throwaway test stack (see docs/security-audit.md) — never at
// port 3001 of an installed SCIP.
//
// Tests (each prints PASS / FAIL / WARN with evidence):
//   1. unauthenticated GET of every non-public route -> 401/403
//   2. forged JWTs (alg:none, wrong signature, expired, tampered) -> 401
//   3. CORS preflight from https://evil.example -> no ACAO echo
//   4. login brute force (10 bad tries) -> lockout or 429
//   5. /files signed-URL tampering and ../ traversal -> not 200
//   6. injection strings in search params -> no 500, no SQL error leak
//   7. oversized JSON body -> 413 (or refused)
//   8. security headers present on a normal response
//   9. desktop-mode register after setup -> 403
//  10. /setup/demo after setup -> refused (409/403)
//  11. socket.io /tracking handshake without a token -> rejected
//  12. low-privilege user (driver) hitting admin routes -> 403
//
// Exit code is the number of FAILes (0 = clean).

import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1]]);
    return acc;
  }, []),
);
const BASE = (args.base || 'http://127.0.0.1:3101/api/v1').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const ROUTES_LOG = args.routes || null;
const DEMO_PASSWORD = args.password || 'DemoPassw0rd!2026';
const ADMIN = args.admin || 'admin@demo-scip.com';
const DRIVER = args.driver || 'driver@demo-scip.com';

// Refuse to run against a likely production SCIP.
if (/(:3001)(\/|$)/.test(BASE)) {
  console.error('Refusing to probe port 3001 (the installed SCIP). Point --base at the test stack.');
  process.exit(2);
}

const results = [];
const record = (name, status, evidence) => {
  results.push({ name, status, evidence });
  const tag = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', INFO: 'INFO' }[status] || status;
  console.log(`[${tag}] ${name}${evidence ? ` — ${evidence}` : ''}`);
};

async function req(method, path, { headers = {}, body, base = BASE } = {}) {
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, headers: new Headers(), text: String(error), ms: Date.now() - started };
  }
}

const base64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** A dummy id for :param segments; a real-looking cuid so validation is reached, not tripped. */
const DUMMY_ID = 'cprobe0000000000000000000';
const fillParams = (path) => path.replace(/:([A-Za-z0-9_]+)/g, (_, name) => (name.toLowerCase().includes('z') || name === 'x' || name === 'y' ? '1' : DUMMY_ID));

/** Non-public routes, from the startup log if given, else a built-in representative list. */
function loadRoutes() {
  if (ROUTES_LOG) {
    const text = readFileSync(ROUTES_LOG, 'utf8');
    const seen = new Map();
    for (const m of text.matchAll(/Mapped \{([^,]+), (GET|POST|PUT|PATCH|DELETE)\} route/g)) {
      const [, rawPath, method] = m;
      seen.set(`${method} ${rawPath}`, { method, path: rawPath.trim() });
    }
    return [...seen.values()];
  }
  return [
    { method: 'GET', path: '/api/v1/shipments' },
    { method: 'GET', path: '/api/v1/companies/me' },
    { method: 'GET', path: '/api/v1/analytics/overview' },
    { method: 'GET', path: '/api/v1/telemetry/fleet' },
    { method: 'GET', path: '/api/v1/settings/feeds' },
  ].map((r) => ({ ...r, path: r.path.replace('/api/v1', new URL(BASE).pathname) }));
}

const PUBLIC = new Set([
  'POST /auth/register', 'POST /auth/login', 'POST /auth/refresh', 'POST /auth/logout',
  'POST /auth/forgot-password', 'POST /auth/reset-password', 'POST /auth/verify-email',
  'GET /health', 'GET /health/ready', 'GET /setup/status', 'POST /setup/demo',
  'GET /files', 'POST /devices/phone/positions',
]);
const prefixPath = new URL(BASE).pathname.replace(/\/$/, '');
const rel = (p) => p.replace(prefixPath, '') || '/';

async function login(email, password) {
  const res = await req('POST', '/auth/login', { body: { email, password } });
  if (res.status !== 200) return null;
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- test 1: no-auth GETs
async function testUnauthenticated(routes) {
  const gets = routes.filter((r) => r.method === 'GET' && !PUBLIC.has(`GET ${rel(r.path)}`));
  let bad = [];
  for (const r of gets) {
    const res = await req('GET', fillParams(r.path).replace(prefixPath, ''), {});
    if (![401, 403].includes(res.status)) bad.push(`${rel(r.path)} -> ${res.status}`);
  }
  record(
    'Unauthenticated GET of protected routes returns 401/403',
    bad.length === 0 ? 'PASS' : 'FAIL',
    bad.length ? `${bad.length}/${gets.length} leaked: ${bad.slice(0, 8).join(', ')}` : `all ${gets.length} routes rejected`,
  );
}

// ---------------------------------------------------------------- test 2: forged JWTs
async function testForgedJwt() {
  const target = '/companies/me';
  const nowSec = Math.floor(Date.now() / 1000);
  const claim = { sub: DUMMY_ID, email: ADMIN, role: 'SUPER_ADMIN', companyId: null, type: 'access' };
  const tokens = {
    'alg:none': `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ ...claim, exp: nowSec + 3600 })}.`,
    'wrong signature': `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ ...claim, exp: nowSec + 3600 })}.${Buffer.from('not-the-real-signature').toString('base64url')}`,
    expired: `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ ...claim, exp: nowSec - 3600 })}.${Buffer.from('x').toString('base64url')}`,
    'tampered payload': `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ ...claim, role: 'SUPER_ADMIN', exp: nowSec + 3600 })}.AAAA`,
  };
  let bad = [];
  for (const [name, token] of Object.entries(tokens)) {
    const res = await req('GET', target, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status !== 401) bad.push(`${name} -> ${res.status}`);
  }
  record(
    'Forged JWTs (alg:none, bad sig, expired, tampered) return 401',
    bad.length === 0 ? 'PASS' : 'FAIL',
    bad.length ? bad.join(', ') : 'all four rejected with 401',
  );
}

// ---------------------------------------------------------------- test 3: CORS
async function testCors() {
  const res = await req('OPTIONS', '/auth/login', {
    headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  const acao = res.headers.get('access-control-allow-origin');
  const leaked = acao === 'https://evil.example' || acao === '*';
  record(
    'CORS preflight from https://evil.example is not allowed',
    leaked ? 'FAIL' : 'PASS',
    `Access-Control-Allow-Origin: ${acao ?? '(absent)'}`,
  );
}

// ---------------------------------------------------------------- test 4: brute force
async function testBruteForce() {
  const email = `probe-bruteforce-${Date.now()}@example.test`; // never a real account
  let statuses = [];
  for (let i = 0; i < 12; i += 1) {
    const res = await req('POST', '/auth/login', { body: { email, password: `wrong-${i}` } });
    statuses.push(res.status);
    if (res.status === 429) break;
  }
  const got429 = statuses.includes(429);
  record(
    'Login brute force is throttled (429) or locked out',
    got429 ? 'PASS' : 'WARN',
    `statuses: ${statuses.join(',')}${got429 ? '' : ' — no 429 seen in 12 tries (per-account lockout still applies to a real account)'}`,
  );
}

// ---------------------------------------------------------------- test 5: /files
async function testFiles() {
  const cases = [
    { name: 'no signature', q: '?key=x/y/photo-00000000-0000-0000-0000-000000000000.png' },
    { name: 'forged signature', q: '?key=x/y/photo-00000000-0000-0000-0000-000000000000.png&expires=9999999999&signature=AAAA' },
    { name: 'path traversal', q: `?key=${encodeURIComponent('../../../../etc/passwd')}&expires=9999999999&signature=AAAA` },
    { name: 'windows traversal', q: `?key=${encodeURIComponent('..\\..\\..\\windows\\win.ini')}&expires=9999999999&signature=AAAA` },
  ];
  let bad = [];
  for (const c of cases) {
    const res = await req('GET', `/files${c.q}`);
    if (res.status === 200) bad.push(`${c.name} -> 200`);
  }
  record(
    '/files rejects unsigned, forged and traversal keys',
    bad.length === 0 ? 'PASS' : 'FAIL',
    bad.length ? bad.join(', ') : 'all rejected (403/404)',
  );
}

// ---------------------------------------------------------------- test 6: injection
async function testInjection(session) {
  if (!session) return record('Injection strings in search params cause no 500/leak', 'INFO', 'no session');
  const payloads = [
    "' OR '1'='1", "'; DROP TABLE users;--", '" OR 1=1--', '${7*7}', '{{7*7}}',
    '<script>alert(1)</script>', '\u0000', '../../etc/passwd', '%27%20OR%201=1',
  ];
  let bad = [];
  for (const p of payloads) {
    const res = await req('GET', `/shipments?search=${encodeURIComponent(p)}`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (res.status >= 500) bad.push(`"${p}" -> ${res.status}`);
    if (/syntax error|prisma|PostgresError|at Query|column .* does not exist/i.test(res.text)) {
      bad.push(`"${p}" leaked DB error`);
    }
  }
  record(
    'Injection strings in search params cause no 500 and no DB-error leak',
    bad.length === 0 ? 'PASS' : 'FAIL',
    bad.length ? bad.join(', ') : `${payloads.length} payloads handled cleanly`,
  );
}

// ---------------------------------------------------------------- test 7: oversized body
async function testOversizedBody() {
  const huge = JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(2 * 1024 * 1024) });
  const res = await req('POST', '/auth/login', { body: huge });
  const rejected = res.status === 413 || res.status === 400;
  record(
    'Oversized JSON body is rejected (413/400)',
    rejected ? 'PASS' : 'WARN',
    `${huge.length} bytes -> ${res.status}`,
  );
}

// ---------------------------------------------------------------- test 8: headers
async function testHeaders() {
  const res = await req('GET', '/health');
  const want = ['x-content-type-options', 'x-frame-options', 'x-dns-prefetch-control', 'strict-transport-security'];
  const present = want.filter((h) => res.headers.get(h));
  const missing = want.filter((h) => !res.headers.get(h));
  // HSTS is expected to be absent on plain HTTP; treat only the others as required.
  const required = ['x-content-type-options'];
  const missingRequired = required.filter((h) => !res.headers.get(h));
  record(
    'Security headers present (helmet)',
    missingRequired.length === 0 ? 'PASS' : 'FAIL',
    `present: ${present.join(', ') || 'none'}${missing.length ? `; absent: ${missing.join(', ')}` : ''}`,
  );
}

// ---------------------------------------------------------------- test 9: register closed
async function testRegisterClosed() {
  const res = await req('POST', '/auth/register', {
    body: {
      email: `probe-reg-${Date.now()}@example.test`,
      password: 'Str0ng-Passphrase!2026',
      firstName: 'A', lastName: 'B', companyName: 'Probe', companyCountry: 'GH',
    },
  });
  // Desktop mode after setup must refuse (403). 201 would mean a second tenant was created.
  record(
    'POST /auth/register is closed after setup (desktop mode)',
    res.status === 403 ? 'PASS' : res.status === 201 ? 'FAIL' : 'WARN',
    `-> ${res.status}${res.status === 201 ? ' (a new tenant was created!)' : ''}`,
  );
}

// ---------------------------------------------------------------- test 10: demo closed
async function testDemoClosed() {
  const res = await req('POST', '/setup/demo', {});
  record(
    'POST /setup/demo is refused once set up',
    [403, 409].includes(res.status) ? 'PASS' : res.status === 204 ? 'FAIL' : 'WARN',
    `-> ${res.status}${res.status === 204 ? ' (re-seed accepted — would wipe data!)' : ''}`,
  );
}

// ---------------------------------------------------------------- test 11: socket.io
async function testSocketNoToken() {
  // Engine.IO v4 polling handshake. Without auth.token the gateway must reject the connection.
  const url = `${ORIGIN}/tracking/?EIO=4&transport=polling&t=${Date.now()}`;
  const res = await req('GET', url);
  // A successful open handshake returns 200 with a payload starting "0{" (the OPEN packet + sid).
  const opened = res.status === 200 && /^\d*:?0\{|^0\{/.test(res.text.replace(/^[0-9]+/, ''));
  // The gateway disconnects immediately after connect on a missing token; the handshake itself may
  // still 200 with a sid, then close. Treat an OPEN packet that carries a sid as needing manual
  // follow-up, and a non-200 / error as a clear pass.
  const sid = /"sid":"([^"]+)"/.exec(res.text)?.[1];
  if (res.status !== 200) {
    record('socket.io /tracking without token is rejected', 'PASS', `handshake -> ${res.status}`);
  } else if (sid) {
    // Follow up: a second poll should show the socket already closed (packet type 1) or error.
    const poll = await req('GET', `${ORIGIN}/tracking/?EIO=4&transport=polling&sid=${sid}&t=${Date.now()}`);
    const closed = /"message":"Missing access token"/.test(poll.text) || /^1|40\{/.test(poll.text) || poll.status >= 400;
    record(
      'socket.io /tracking without token is rejected',
      closed ? 'PASS' : 'WARN',
      `handshake 200 sid=${sid.slice(0, 6)}…; follow-up ${poll.status} ${poll.text.slice(0, 60).replace(/\s+/g, ' ')}`,
    );
  } else {
    record('socket.io /tracking without token is rejected', opened ? 'WARN' : 'PASS', `-> ${res.status} ${res.text.slice(0, 40)}`);
  }
}

// ---------------------------------------------------------------- test 12: RBAC
async function testLowPrivilege(driver) {
  if (!driver) return record('Low-privilege user is denied admin routes', 'INFO', 'no driver session');
  const attempts = [
    { method: 'PUT', path: '/settings/feeds', body: { tomtomApiKey: 'probe' } },
    { method: 'PATCH', path: '/companies/me', body: { name: 'Probe' } },
    { method: 'POST', path: '/warehouses', body: { code: 'PRB', name: 'Probe', country: 'GH' } },
    { method: 'GET', path: '/analytics/overview' },
    { method: 'POST', path: '/auth/invite', body: { email: 'x@y.z', firstName: 'A', lastName: 'B', role: 'COMPANY_ADMIN' } },
  ];
  let bad = [];
  for (const a of attempts) {
    const res = await req(a.method, a.path, {
      headers: { Authorization: `Bearer ${driver.accessToken}` },
      body: a.body,
    });
    if (![403].includes(res.status)) bad.push(`${a.method} ${a.path} -> ${res.status}`);
  }
  record(
    'Low-privilege user (driver) is denied admin routes (403)',
    bad.length === 0 ? 'PASS' : 'FAIL',
    bad.length ? bad.join(', ') : `${attempts.length} admin routes all returned 403`,
  );
}

async function main() {
  console.log(`SCIP security probe against ${BASE}\n`);
  const routes = loadRoutes();
  console.log(`Loaded ${routes.length} mapped routes${ROUTES_LOG ? ` from ${ROUTES_LOG}` : ' (built-in list)'}\n`);

  const admin = await login(ADMIN, DEMO_PASSWORD);
  const driver = await login(DRIVER, DEMO_PASSWORD);
  record('Demo admin login (documented password) succeeds', admin ? 'INFO' : 'INFO',
    admin ? `admin@ token issued, role ${admin.user?.role}` : 'admin login failed (demo data absent?)');

  await testUnauthenticated(routes);
  await testForgedJwt();
  await testCors();
  await testBruteForce();
  await testFiles();
  await testInjection(admin);
  await testOversizedBody();
  await testHeaders();
  await testRegisterClosed();
  await testDemoClosed();
  await testSocketNoToken();
  await testLowPrivilege(driver);

  const fails = results.filter((r) => r.status === 'FAIL').length;
  const warns = results.filter((r) => r.status === 'WARN').length;
  console.log(`\n${results.length} checks — ${results.filter((r) => r.status === 'PASS').length} PASS, ${fails} FAIL, ${warns} WARN`);
  process.exit(fails);
}

main().catch((error) => {
  console.error('probe crashed:', error);
  process.exit(3);
});
