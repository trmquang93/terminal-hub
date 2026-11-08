// Records which git checkout the app is built from (build/build-info.json, shipped as Resources/build-info.json).
// The in-app updater reads `repo` to know where to pull and rebuild from.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const info = { repo: root, commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD') };
const out = join(root, 'build');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`wrote ${join(out, 'build-info.json')}`);
