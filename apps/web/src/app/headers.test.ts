// Static check of the Cloudflare `_headers` file (Pages and Workers Static Assets share the syntax).
// Vite only copies it; the browser behaviour under this CSP is checked in tests/e2e/csp.spec.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const text = readFileSync(join(process.cwd(), 'public/_headers'), 'utf8'); // vitest runs in apps/web

/** path pattern -> header name (lower case) -> value. Indented "Name: value" lines belong to the last path. */
function parse(src: string) {
  const rules = new Map<string, Map<string, string>>();
  let cur: Map<string, string> | null = null;
  for (const line of src.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) rules.set(line.trim(), (cur = new Map()));
    else {
      const i = line.indexOf(':');
      if (!cur || i < 0) throw new Error(`bad header line: ${line}`);
      cur.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
  }
  return rules;
}
const rules = parse(text);
const all = rules.get('/*')!;
const csp = new Map(all.get('content-security-policy')!.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));

describe('_headers', () => {
  it('CSP allows Go WASM without unsafe-eval or inline script, and locks down the rest', () => {
    expect(csp.get('default-src')).toEqual(["'none'"]);
    expect(csp.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(csp.get('style-src')).toEqual(["'self'"]);
    expect(csp.get('img-src')).toEqual(["'self'"]);
    expect(csp.get('font-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('form-action')).toEqual(["'none'"]);
    // Same-origin assets + user-initiated collector WebSocket (loopback or LAN host, see docs/security.md).
    expect(csp.get('connect-src')).toEqual(["'self'", 'ws:', 'wss:']);
    // Would rewrite ws://127.0.0.1 to wss:// and break the local collector.
    expect(csp.has('upgrade-insecure-requests')).toBe(false);
    expect(all.get('content-security-policy')).not.toMatch(/'unsafe-eval'|unsafe-inline|\*/);
  });

  it('other security headers', () => {
    expect(all.get('x-content-type-options')).toBe('nosniff');
    expect(all.get('referrer-policy')).toBe('no-referrer');
    expect(all.get('cross-origin-opener-policy')).toBe('same-origin');
    const pp = all.get('permissions-policy')!;
    expect(pp).toMatch(/(^|, )gamepad=\(self\)/);
    expect(pp).toMatch(/(^|, )microphone=\(self\)/);
    for (const f of ['camera', 'geolocation', 'usb', 'hid', 'serial', 'bluetooth', 'payment', 'display-capture']) expect(pp).toMatch(new RegExp(`(^|, )${f}=\\(\\)`));
  });

  it('caching: hashed assets (incl. wasm_exec + core.wasm, see vite/wasmAssets.ts) immutable; entry and version revalidated', () => {
    expect(all.has('cache-control')).toBe(false); // would be comma-joined with the per-path values
    expect(rules.get('/assets/*')!.get('cache-control')).toBe('public, max-age=31536000, immutable');
    for (const p of ['/', '/index.html', '/version.json']) expect(rules.get(p)?.get('cache-control'), p).toBe('no-cache');
    expect(rules.has('/wasm/*')).toBe(false); // the bundle has no unhashed runtime/core any more
  });
});
