// Installs release/mac-arm64/Terminal Hub.app into /Applications and the `hub` launcher into /opt/homebrew/bin.
// Safe to re-run. Overrides (for tests): HUB_APPS_DIR, HUB_BIN_DIR.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAppRunning, listProcesses } from './app-running.mjs';

const root = join(import.meta.dirname, '..');
const source = join(root, 'release', 'mac-arm64', 'Terminal Hub.app');
const appsDir = process.env.HUB_APPS_DIR ?? '/Applications';
const binDir = process.env.HUB_BIN_DIR ?? '/opt/homebrew/bin';
const target = join(appsDir, 'Terminal Hub.app');
const launcher = join(binDir, 'hub');

if (!existsSync(source)) {
  console.error(`missing ${source}; run: npm run package:app`);
  process.exit(1);
}

if (isAppRunning(target, listProcesses())) {
  console.error(`Terminal Hub is running from ${target}. Quit it first (running sessions would be interrupted), then re-run.`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
execFileSync('ditto', [source, target]);
// electron-builder leaves the bundle with only the linker's ad-hoc signature on the main binary (`codesign --verify` fails); seal it as a whole.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'ignore' });
console.log(`installed ${target}`);

const script = `#!/bin/sh
# Terminal Hub CLI launcher. Written by \`npm run install:app\` in the terminal-hub project; safe to overwrite.
app=${shq(target)}
cli="$app/Contents/Resources/hub/hub.cjs"
node=/opt/homebrew/bin/node
[ -x "$node" ] || node=$(command -v node)
if [ ! -f "$cli" ]; then
  echo "hub: Terminal Hub is not installed at $app (moved or deleted). Reinstall: npm run install:app in the terminal-hub project." >&2
  exit 127
fi
if [ -z "$node" ]; then
  echo "hub: node not found (expected /opt/homebrew/bin/node)." >&2
  exit 127
fi
exec "$node" "$cli" "$@"
`;
mkdirSync(binDir, { recursive: true });
const tmp = `${launcher}.tmp-${process.pid}`;
writeFileSync(tmp, script);
chmodSync(tmp, 0o755);
renameSync(tmp, launcher); // replaces a stale file or symlink (e.g. from `npm link`) instead of writing through it
console.log(`installed ${launcher}`);

function shq(value) {
  return `"${value.replaceAll(/(["\\$`])/g, '\\$1')}"`;
}
