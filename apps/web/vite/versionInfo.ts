import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

export type VersionInfo = { version: string; commit: string; buildTime: string };
type Git = (args: string[]) => string;

const git: Git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Build time is the commit time, so the same commit always yields the same version.json. */
export function resolveVersionInfo(env: Record<string, string | undefined>, run: Git = git): VersionInfo {
  const ask = (args: string[]) => { try { return run(args).trim() || 'unknown'; } catch { return 'unknown'; } };
  return {
    version: env.VITE_APP_VERSION || 'dev',
    commit: env.GITHUB_SHA || ask(['rev-parse', 'HEAD']),
    buildTime: ask(['show', '-s', '--format=%cI', 'HEAD']),
  };
}

export function writeVersionJson(dir: string, info: VersionInfo) {
  writeFileSync(join(dir, 'version.json'), `${JSON.stringify(info, null, 2)}\n`);
}

/** Exposes the commit to the app (footer) and emits dist/version.json. */
export function versionPlugin(info: VersionInfo = resolveVersionInfo(process.env)): Plugin {
  let outDir = 'dist';
  return {
    name: 'tbt-version-json',
    config: () => ({ define: { 'import.meta.env.VITE_APP_COMMIT': JSON.stringify(info.commit) } }),
    configResolved: (c) => { outDir = join(c.root, c.build.outDir); },
    closeBundle: () => writeVersionJson(outDir, info),
  };
}
