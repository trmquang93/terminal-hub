import { execFile } from 'node:child_process';

/** PATH of the user's login shell; GUI-launched apps start with a minimal PATH. */
export function loginShellPath(shell: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(shell, ['-l', '-i', '-c', 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout) => {
      const match = error ? null : /__PATH__(.*?)__PATH__/s.exec(stdout);
      resolve(match?.[1] ?? null);
    });
    // Without a terminal an interactive rc file may wait for input (e.g. oh-my-zsh's update prompt): give it EOF, and SIGKILL (not SIGTERM, which interactive shells ignore) on timeout.
    child.stdin?.end();
  });
}
