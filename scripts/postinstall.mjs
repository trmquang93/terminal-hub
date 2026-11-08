// 1) node-pty ships its spawn-helper without the executable bit on some installs.
// 2) npm may skip Electron's binary download; fetch it so `npm start` works right after `npm install`.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const modules = join(import.meta.dirname, '..', 'node_modules');
const prebuilds = join(modules, 'node-pty', 'prebuilds');
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

const electron = join(modules, 'electron');
if (existsSync(join(electron, 'install.js')) && !existsSync(join(electron, 'dist'))) {
  spawnSync(process.execPath, [join(electron, 'install.js')], { stdio: 'inherit' });
}
