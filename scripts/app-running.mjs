// Detects whether the app bundle at `target` has a running process, by executable path (not by command-line regex).
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// processList: executable paths of running processes. True when any of them lives inside the bundle
// (main binary in Contents/MacOS, helpers in Contents/Frameworks). The trailing separator keeps "X.app.backup" from matching "X.app".
export function isAppRunning(target, processList) {
  const roots = [resolve(target)];
  try {
    roots.push(realpathSync(target)); // the kernel reports resolved paths (e.g. /tmp is /private/tmp)
  } catch {
    // target not installed yet: only the literal path applies
  }
  const prefixes = roots.map((root) => root.replace(/\/+$/, '') + sep);
  return processList.some((exe) => prefixes.some((prefix) => exe.startsWith(prefix)));
}

// Executable path of every running process. `ps comm=` prints the full path with no arguments, so spaces in paths are unambiguous.
// Throws if ps fails: the caller must not treat "could not look" as "not running".
export function listProcesses() {
  const out = execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter((line) => line !== '');
}
