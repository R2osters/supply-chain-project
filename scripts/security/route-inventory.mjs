#!/usr/bin/env node
// Static inventory of the API routes and of what protects each one.
//
//   node scripts/security/route-inventory.mjs            -> Markdown table on stdout
//   node scripts/security/route-inventory.mjs --json     -> JSON
//
// For every @Get/@Post/@Put/@Patch/@Delete handler of every *.controller(s).ts file under
// apps/api/src it reports: the HTTP method and path, whether the route is @Public(), the
// permissions required by @RequirePermissions (method level, else class level), and the
// explicit @Throttle override. A mutating route that is neither public nor permission-gated
// is callable by ANY authenticated role (DRIVER, CUSTOMER, SUPPLIER, VIEWER...): the script
// flags it as "any-auth" so a reviewer can judge whether that is intended.
//
// It is a regex parser, not a TypeScript compiler: good enough for the decorator style used in
// this code base (one decorator per line), and deliberately dependency-free.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(REPO, 'apps', 'api', 'src');
const PREFIX = '/api/v1';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    // Some modules declare their controller inline (analytics.module.ts, incidents.module.ts).
    else if (/\.ts$/.test(name) && !/\.spec\.ts$/.test(name) && readFileSync(full, 'utf8').includes('@Controller(')) {
      out.push(full);
    }
  }
  return out;
}

const ROUTE_RE = /^\s*@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)?\s*\)/;
const CONTROLLER_RE = /@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/;
const PERM_RE = /@RequirePermissions\(([^)]*)\)/;
const THROTTLE_RE = /@Throttle\((.*)\)\s*$/;

const joinPath = (...parts) =>
  '/' + parts.filter((p) => p !== undefined && p !== '').map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

const routes = [];
for (const file of walk(SRC)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let klass = null; // { base, public, perms, line }
  let pending = []; // decorator lines seen since the last member
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('@')) {
      pending.push({ text: trimmed, line: i + 1 });
      continue;
    }
    if (/^export\s+class\s+\w+/.test(trimmed)) {
      const ctl = pending.map((d) => d.text.match(CONTROLLER_RE)).find(Boolean);
      const perm = pending.map((d) => d.text.match(PERM_RE)).find(Boolean);
      klass = ctl
        ? {
            name: trimmed.match(/class\s+(\w+)/)[1],
            base: ctl[1] ?? ctl[2] ?? '',
            public: pending.some((d) => d.text.startsWith('@Public(')),
            perms: perm ? perm[1].replace(/['"\s]/g, '').split(',').filter(Boolean) : [],
          }
        : null;
      pending = [];
      continue;
    }
    if (klass && pending.length && /^(async\s+)?\w+\s*\(/.test(trimmed)) {
      const route = pending.map((d) => ({ m: d.text.match(ROUTE_RE), line: d.line })).find((x) => x.m);
      if (route) {
        const method = route.m[1].toUpperCase();
        const sub = route.m[2] ?? route.m[3] ?? route.m[4] ?? '';
        const perm = pending.map((d) => d.text.match(PERM_RE)).find(Boolean);
        const throttle = pending.map((d) => d.text.match(THROTTLE_RE)).find(Boolean);
        const isPublic = klass.public || pending.some((d) => d.text.startsWith('@Public('));
        const perms = perm ? perm[1].replace(/['"\s]/g, '').split(',').filter(Boolean) : klass.perms;
        routes.push({
          method,
          path: joinPath(PREFIX, klass.base, sub),
          controller: klass.name,
          handler: trimmed.match(/^(?:async\s+)?(\w+)/)[1],
          file: relative(REPO, file).replace(/\\/g, '/'),
          line: route.line,
          public: isPublic,
          permissions: perms,
          throttle: throttle ? throttle[1] : null,
          access: isPublic ? 'PUBLIC' : perms.length ? 'permission' : 'any-auth',
        });
      }
      pending = [];
      continue;
    }
    if (trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) {
      // A decorator block ends at the member it decorates; anything else resets it.
      if (!/^\)|^\}|^[\w@'"`{[,]/.test(trimmed) || /;$/.test(trimmed)) pending = [];
    }
  }
}

routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(routes, null, 2) + '\n');
} else {
  const mutating = (r) => r.method !== 'GET';
  console.log(`| Méthode | Route | Accès | Permissions | Throttle | Source |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const r of routes) {
    const flag = r.access === 'any-auth' && mutating(r) ? ' ⚠' : '';
    console.log(
      `| ${r.method} | \`${r.path}\` | ${r.access}${flag} | ${r.permissions.join(', ') || '—'} | ${r.throttle ?? '—'} | ${r.file}:${r.line} |`,
    );
  }
  const count = (pred) => routes.filter(pred).length;
  console.log(
    `\n${routes.length} routes: ${count((r) => r.public)} public, ${count((r) => r.access === 'permission')} permission-gated, ` +
      `${count((r) => r.access === 'any-auth')} any authenticated user ` +
      `(${count((r) => r.access === 'any-auth' && mutating(r))} of them mutating).`,
  );
}
