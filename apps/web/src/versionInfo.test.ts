import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVersionInfo, writeVersionJson } from '../vite/versionInfo.ts';


describe('version info', () => {
  it('uses env version, commit from git and commit time as build time', () => {
    const run = (args: string[]) => (args[0] === 'rev-parse' ? '0123456789abcdef0123456789abcdef01234567\n' : '2026-11-14T03:41:52+05:30\n');
    expect(resolveVersionInfo({ VITE_APP_VERSION: 'v0.1.0' }, run)).toEqual({
      version: 'v0.1.0',
      commit: '0123456789abcdef0123456789abcdef01234567',
      buildTime: '2026-11-14T03:41:52+05:30',
    });
  });

  it('falls back to dev/unknown when git is unavailable (never throws)', () => {
    const run = () => { throw new Error('no git'); };
    expect(resolveVersionInfo({}, run)).toEqual({ version: 'dev', commit: 'unknown', buildTime: 'unknown' });
  });

  it('prefers GITHUB_SHA over git for the commit', () => {
    const run = (args: string[]) => (args[0] === 'rev-parse' ? 'aaaa\n' : 't\n');
    expect(resolveVersionInfo({ GITHUB_SHA: 'bbbb' }, run).commit).toBe('bbbb');
  });

  it('writes version.json into the output dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vj-'));
    const info = { version: 'dev', commit: 'abc', buildTime: 't' };
    writeVersionJson(dir, info);
    expect(JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8'))).toEqual(info);
  });
});
