// Bundles src/cli/hub.ts into one self-contained CommonJS file for Terminal Hub.app (Contents/Resources/hub/).
// Also writes `hub`, a wrapper that runs hub.cjs with the app's own Electron binary as Node, so a `hub hook-notify`
// command line does not depend on a `node` being on PATH. The app no longer installs such a hook itself.
import { build } from 'esbuild';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(import.meta.dirname, '..', 'build', 'hub');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(import.meta.dirname, '..', 'src', 'cli', 'hub.ts')],
  outfile: join(out, 'hub.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  define: { HUB_PACKAGED: 'true' },
  logLevel: 'warning',
});

const wrapper = join(out, 'hub');
writeFileSync(
  wrapper,
  `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
ELECTRON_RUN_AS_NODE=1 exec "$here/../../MacOS/Terminal Hub" "$here/hub.cjs" "$@"
`,
);
chmodSync(wrapper, 0o755);
console.log(`built ${out}`);
