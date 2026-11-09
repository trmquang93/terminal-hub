import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeCwd, isUuid } from '../src/main/claude';
import { createApiServer, listenOnLoopback } from '../src/main/apiServer';
import { SessionManager } from '../src/main/sessionManager';
import { SessionStore } from '../src/main/sessionStore';
import type { SessionInfo, SessionMeta } from '../src/shared/types';

let base: string;
let bin: string;
let work: string;
let config: string;
let managers: SessionManager[];
// Agent sessions keep no output.log, so output is collected from the live events of every session.
let seen: Map<string, string>;

// A stand-in `claude` that reports how it was launched and, like the real one, writes a transcript.
const FAKE_CLAUDE = `#!/bin/sh
echo "ARGS=$*"
echo "CFG=$CLAUDE_CONFIG_DIR"
echo "PWD=$(pwd -P)"
sid=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--session-id" ] || [ "$prev" = "--resume" ]; then sid="$a"; fi
  prev="$a"
done
[ -z "$sid" ] && sid="$FAKE_SESSION"
proj="$CLAUDE_CONFIG_DIR/projects/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$proj" && echo '{}' >> "$proj/$sid.jsonl"
sleep "\${FAKE_SLEEP:-0}"
`;

function track(m: SessionManager): SessionManager {
  m.onOutput(({ id, data }) => seen.set(id, (seen.get(id) ?? '') + data.toString()));
  managers.push(m);
  return m;
}

function manager(): SessionManager {
  return track(new SessionManager(new SessionStore(join(base, 'sessions')), 'test', { baseEnv: () => ({ PATH: `${bin}:/usr/bin:/bin` }) }));
}

function exited(m: SessionManager, id: string): Promise<SessionInfo> {
  return new Promise((resolve) => {
    const done = (): void => {
      const s = m.get(id);
      if (s && !s.running) resolve(s);
    };
    m.onChanged(done);
    done();
  });
}

const readMeta = (id: string): SessionMeta => JSON.parse(readFileSync(join(base, 'sessions', id, 'meta.json'), 'utf8')) as SessionMeta;
const text = (_m: SessionManager, id: string): Promise<string> => Promise.resolve(seen.get(id) ?? '');

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'thub-mgr-')));
  bin = join(base, 'bin');
  work = join(base, 'work');
  config = join(base, 'cfg');
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);
  managers = [];
  seen = new Map();
});
afterEach(async () => {
  for (const m of managers) await m.shutdown();
  rmSync(base, { recursive: true, force: true });
});

describe('SessionManager — Claude Code sessions', () => {
  it('starts claude with --session-id <uuid> and records claude.sessionId and configDir', async () => {
    const m = manager();
    const created = m.start({ cwd: work, command: 'claude', args: ['--model', 'x'], env: { CLAUDE_CONFIG_DIR: config } });
    const sessionId = created.claude?.sessionId ?? '';
    expect(isUuid(sessionId)).toBe(true);
    expect(sessionId).not.toBe(created.id);
    expect(created.argv).toEqual(['--session-id', sessionId, '--model', 'x']);
    expect(created.claude?.configDir).toBe(config);
    expect(created.state).toBe('running');

    const done = await exited(m, created.id);
    expect(done).toMatchObject({ state: 'exited', exitCode: 0, resumable: true });
    expect(await text(m, created.id)).toContain(`ARGS=--session-id ${sessionId} --model x`);
    const onDisk = readMeta(created.id);
    expect(onDisk.claude).toMatchObject({ sessionId, configDir: config, resumeCommand: `claude --resume ${sessionId} --model x` });
  });

  it('resume relaunches in the same entry: --resume <uuid>, same cwd and env, appended after a separator', async () => {
    const m = manager();
    const { id, claude } = m.start({ cwd: work, command: 'claude', env: { CLAUDE_CONFIG_DIR: config } });
    await exited(m, id);
    const before = await text(m, id);

    const resumed = m.resume(id);
    expect(resumed).toMatchObject({ id, state: 'running', running: true, resumeCount: 1, endedAt: null, exitCode: null });
    await exited(m, id);
    const after = await text(m, id);
    expect(after.startsWith(before)).toBe(true);
    const added = after.slice(before.length);
    expect(added).toMatch(/── resumed \d{4}-\d\d-\d\dT[\d:.]+Z ──/);
    expect(added).toContain(`ARGS=--resume ${claude?.sessionId}`);
    expect(added).toContain(`CFG=${config}`);
    expect(added).toContain(`PWD=${work}`);
    expect(m.list()).toHaveLength(1);
  });

  it('resumes with --session-id <same uuid> when Claude never wrote a transcript, so Resume still works', async () => {
    const m = manager();
    const { id, claude } = m.start({ cwd: work, command: 'claude', env: { CLAUDE_CONFIG_DIR: config } });
    await exited(m, id);
    rmSync(join(config, 'projects'), { recursive: true });
    m.resume(id);
    await exited(m, id);
    expect(await text(m, id)).toContain(`ARGS=--session-id ${claude?.sessionId}`);
    expect(m.get(id)?.claude?.sessionId).toBe(claude?.sessionId);
  });

  it('refuses to resume a running session (409) and a Claude session without an id (400)', async () => {
    const m = manager();
    const running = m.start({ cwd: work, command: 'claude', env: { CLAUDE_CONFIG_DIR: config, FAKE_SLEEP: '30' } });
    expect(() => m.resume(running.id)).toThrow(/already running/);
    const unknown = m.start({ cwd: work, command: 'claude', args: ['--continue'], env: { CLAUDE_CONFIG_DIR: join(base, 'empty-cfg') } });
    expect(unknown.claude?.sessionId).toBeNull();
    await exited(m, unknown.id);
    expect(m.get(unknown.id)?.resumable).toBe(false);
    expect(() => m.resume(unknown.id)).toThrow(/cannot resume/);
  });

  it('stores a session id discovered from the transcript when none was known, and never overwrites it', async () => {
    const m = manager();
    const found = '5f1d2c3b-6a7e-4b89-9c0d-1e2f3a4b5c6d';
    const { id } = m.start({ cwd: work, command: 'claude', args: ['--continue'], env: { CLAUDE_CONFIG_DIR: config, FAKE_SESSION: found } });
    const done = await exited(m, id);
    expect(done.claude?.sessionId).toBe(found);
    expect(done.claude?.resumeCommand).toBe(`claude --resume ${found}`);
    expect(done.resumable).toBe(true);
    expect(encodeCwd(work)).toBe(work.replaceAll(/[^A-Za-z0-9]/g, '-'));

    // a newer transcript appearing later must not replace the recorded id
    writeFileSync(join(config, 'projects', encodeCwd(work), '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a.jsonl'), '{}');
    expect(manager().get(id)?.claude?.sessionId).toBe(found);
  });

  it('marks sessions interrupted when the app shuts down, and they stay resumable after a reload', async () => {
    const m = manager();
    const { id, claude } = m.start({ cwd: work, command: 'claude', env: { CLAUDE_CONFIG_DIR: config, FAKE_SLEEP: '30' } });
    await m.shutdown();
    const stopped = m.get(id);
    expect(stopped).toMatchObject({ state: 'interrupted', running: false, resumable: true });
    expect(stopped?.endedAt).not.toBeNull();

    const reloaded = manager().get(id);
    expect(reloaded).toMatchObject({ state: 'interrupted', running: false, resumable: true });
    expect(reloaded?.claude?.sessionId).toBe(claude?.sessionId);
  });

  it('a session still recorded as running (crash / reboot) loads as interrupted', () => {
    const store = new SessionStore(join(base, 'sessions'));
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'claude', env: { CLAUDE_CONFIG_DIR: config, FAKE_SLEEP: '30' } });
    expect(readMeta(id).state).toBe('running');
    expect(store.loadAll().find((s) => s.id === id)?.state).toBe('interrupted');
  });
});

describe('SessionManager — attention and answers', () => {
  const nextAttention = (m: SessionManager, id: string): Promise<SessionInfo> =>
    new Promise((resolve) => {
      const off = m.onAttention((session) => {
        if (session.id === id && session.attention) {
          off();
          resolve(session);
        }
      });
    });

  it('flags a [y/N] prompt within 2 s, exposes the question, and an answer makes the session continue', async () => {
    const m = manager();
    const started = Date.now();
    const { id } = m.start({ cwd: work, command: 'sh', args: ['-c', 'read -p "Continue? [y/N] " a; echo got=$a'] });
    const flagged = await nextAttention(m, id);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(flagged.attention).toMatchObject({ reason: 'prompt', source: 'heuristic', promptText: 'Continue? [y/N]' });
    expect(m.get(id)?.attention?.promptText).toBe('Continue? [y/N]');

    expect(m.answer(id, { text: 'y', submit: true })).toBe('y\r');
    expect(m.get(id)?.attention).toBeNull();
    await exited(m, id);
    expect(await text(m, id)).toContain('got=y');
  });

  it('answers 409 for an exited session', async () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'sh', args: ['-c', 'true'] });
    await exited(m, id);
    expect(() => m.answer(id, { text: 'yes' })).toThrow(/not running/);
  });

  it('a busy session that prints a prompt-free stream is never flagged as a prompt, and idle is only idle', async () => {
    const m = new SessionManager(new SessionStore(join(base, 'sessions')), 'test', { baseEnv: () => ({ PATH: '/usr/bin:/bin' }), attention: { idleMs: 700, quietMs: 100 } });
    managers.push(m);
    const { id } = m.start({ cwd: work, command: 'sh', args: ['-c', 'for i in 1 2 3 4 5 6; do echo working $i; sleep 0.2; done; sleep 30'] });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(m.get(id)?.attention).toBeNull();
    const idle = await nextAttention(m, id);
    expect(idle.attention).toMatchObject({ reason: 'idle', source: 'idle' });
  });

  it('unattended sessions auto-approve "Do you want to proceed?" with Enter only, and log it to answers.log', async () => {
    const m = manager();
    const script = 'printf "Bash command\\n ❯ 1. Yes\\n   2. No\\nDo you want to proceed?\\n"; IFS= read -r a; echo "answered=[$a]"; printf "Delete everything? [y/N] "; sleep 30';
    const { id, autoAnswer } = m.start({ cwd: work, command: 'sh', args: ['-c', script], unattended: true });
    expect(autoAnswer).toEqual({ enabled: true, rules: [{ match: 'Do you want to proceed?', keys: '\r' }], timeoutSec: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await text(m, id)).toContain('answered=[]');
    const log = readFileSync(join(base, 'sessions', id, 'answers.log'), 'utf8').trim().split('\n');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0] ?? '{}')).toMatchObject({ rule: 'Do you want to proceed?', keys: '\r' });
    // the second, non-matching prompt is left for the person
    expect(m.get(id)?.attention?.promptText).toContain('Delete everything? [y/N]');
  });

  it('a session without a policy is never auto-answered', async () => {
    const m = manager();
    const { id, autoAnswer } = m.start({ cwd: work, command: 'sh', args: ['-c', 'printf "Do you want to proceed?\\n"; sleep 30'] });
    expect(autoAnswer).toBeNull();
    await nextAttention(m, id);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(m.get(id)?.attention?.reason).toBe('prompt');
    expect(() => readFileSync(join(base, 'sessions', id, 'answers.log'))).toThrow();
  });

  it('maps a Claude Code Notification hook to its session by hub id or Claude session id', () => {
    const m = manager();
    const { id, claude } = m.start({ cwd: work, command: 'claude', env: { CLAUDE_CONFIG_DIR: config, FAKE_SLEEP: '30' } });
    expect(m.hookNotify({ hubSessionId: '99999999-9999-4999-8999-999999999999', message: 'x' })).toBe(false);
    expect(m.hookNotify({ sessionId: claude?.sessionId ?? '', message: 'Claude needs your permission to use Bash' })).toBe(true);
    expect(m.get(id)?.attention).toMatchObject({ reason: 'prompt', source: 'hook', promptText: 'Claude needs your permission to use Bash' });
    expect(m.hookNotify({ hubSessionId: id, message: 'again' })).toBe(true);
  });

  it('derives the turn state from hook events: dedupes repeats, SessionEnd clears, and a question hook still raises attention', () => {
    const m = manager();
    const changes: (string | undefined)[] = [];
    m.onTurn((session) => changes.push(session.turn?.state));
    const { id } = m.start({ cwd: work, command: 'claude', env: { CLAUDE_CONFIG_DIR: config, FAKE_SLEEP: '30' } });
    expect(m.get(id)?.turn).toBeNull();
    const hook = (hookEvent: string, message = ''): boolean => m.hookNotify({ hubSessionId: id, message, hookEvent });
    hook('SessionStart');
    hook('UserPromptSubmit');
    const since = m.get(id)?.turn?.since;
    hook('PreToolUse');
    hook('PostToolUse');
    expect(m.get(id)?.turn).toEqual({ state: 'working', since });
    hook('PermissionRequest'); // a tool permission request is not a Notification: no attention prompt
    expect(m.get(id)?.turn?.state).toBe('waiting');
    expect(m.get(id)?.attention).toBeNull();
    hook('Notification', 'Claude needs your permission to use Bash');
    expect(m.get(id)?.attention).toMatchObject({ reason: 'prompt', source: 'hook' });
    hook('Stop');
    hook('Stop');
    expect(m.get(id)?.turn?.state).toBe('done');
    hook('SessionEnd');
    expect(m.get(id)?.turn).toBeNull();
    expect(changes).toEqual(['working', 'waiting', 'done', undefined]);
  });

  it('launches Claude with --settings <hub hooks file> unless the user passed one, refreshing the file per launch', async () => {
    const calls: string[] = [];
    const hooksFile = join(base, 'claude-hooks.json');
    const m = track(new SessionManager(new SessionStore(join(base, 'sessions')), 'test', { baseEnv: () => ({ PATH: `${bin}:/usr/bin:/bin` }), hooksFile: () => (calls.push('refresh'), hooksFile) }));
    const env = { CLAUDE_CONFIG_DIR: config };
    const mine = m.start({ cwd: work, command: 'claude', args: ['--settings', '/mine.json'], env });
    const hub = m.start({ cwd: work, command: 'claude', env });
    expect(calls).toHaveLength(2);
    expect(hub.claude?.resumeCommand).toContain(`--settings ${hooksFile}`);
    expect(mine.claude?.resumeCommand).not.toContain(hooksFile);
    const outputOf = async (id: string): Promise<string> => {
      for (let i = 0; i < 50; i++) {
        const output = await text(m, id);
        if (output.includes('ARGS=')) return output;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return '';
    };
    expect(await outputOf(hub.id)).toContain(`--settings ${hooksFile}`);
    expect(await outputOf(mine.id)).not.toContain(hooksFile);
  });

  it('never writes to the Claude config dir when a Claude session starts', () => {
    mkdirSync(config);
    const settings = join(config, 'settings.json');
    writeFileSync(settings, '{"hooks":{}}\n');
    const m = manager();
    m.start({ cwd: work, command: 'claude', env: { CLAUDE_CONFIG_DIR: config, FAKE_SLEEP: '30' } });
    expect(readFileSync(settings, 'utf8')).toBe('{"hooks":{}}\n');
    expect(readdirSync(config).filter((name) => name.includes('terminal-hub') || name.endsWith('.tmp'))).toEqual([]);
  });

  it('gives every session its id in TERMINAL_HUB_SESSION_ID so the hook can find it', async () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'sh', args: ['-c', 'echo sid=$TERMINAL_HUB_SESSION_ID'] });
    await exited(m, id);
    expect(await text(m, id)).toContain(`sid=${id}`);
  });
});

describe('SessionManager — plain commands', () => {
  it('records output and exit code, and restart reruns the original command in the same entry', async () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'sh', args: ['-c', 'echo first; exit 3'] });
    expect(await exited(m, id)).toMatchObject({ exitCode: 3, state: 'exited', claude: null, resumable: true, title: `sh — work` });
    m.resume(id);
    await exited(m, id);
    expect((await text(m, id)).match(/first/g)).toHaveLength(2);
  });

  it('rejects input to a session that is no longer running', async () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'sh', args: ['-c', 'true'] });
    await exited(m, id);
    expect(() => m.write(id, 'x')).toThrow(/not running/);
  });

  it('rejects a missing cwd and an unknown command without leaving a session behind', () => {
    const m = manager();
    expect(() => m.start({ cwd: join(base, 'nope'), command: 'sh' })).toThrow(/cwd/);
    expect(() => m.start({ cwd: work, command: 'definitely-not-a-command' })).toThrow(/not found/);
    expect(m.list()).toHaveLength(0);
    expect(new SessionStore(join(base, 'sessions')).loadAll()).toHaveLength(0);
  });

  it('remove kills a running session and deletes its folder', async () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'sleep', args: ['60'] });
    await m.remove(id);
    expect(m.get(id)).toBeUndefined();
    expect(() => readFileSync(join(base, 'sessions', id, 'meta.json'))).toThrow();
  });
});

describe('SessionManager — archive and batch delete', () => {
  it('new sessions are not archived; setArchived persists, emits changed and survives a reload', async () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'sh', args: ['-c', 'true'] });
    expect(m.get(id)?.archived).toBe(false);
    await exited(m, id);

    const changes: SessionInfo[] = [];
    m.onChanged((session) => changes.push(session));
    expect(m.setArchived(id, true)).toMatchObject({ id, archived: true });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id, archived: true });
    expect(readMeta(id).archived).toBe(true);
    expect(manager().get(id)?.archived).toBe(true);

    expect(m.setArchived(id, false).archived).toBe(false);
    expect(readMeta(id).archived).toBe(false);
  });

  it('refuses to archive a running session (400) but unarchive is always allowed', () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'sleep', args: ['60'] });
    expect(() => m.setArchived(id, true)).toThrow(/running/);
    expect(m.get(id)?.archived).toBe(false);
    expect(readMeta(id).archived).toBe(false);
    expect(m.setArchived(id, false).archived).toBe(false);
    expect(() => m.setArchived('99999999-9999-4999-8999-999999999999', true)).toThrow(/no such session/);
  });

  it('resuming an archived session brings it back to the main list', async () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'sh', args: ['-c', 'true'] });
    await exited(m, id);
    m.setArchived(id, true);
    m.resume(id);
    expect(m.get(id)?.archived).toBe(false);
    expect(readMeta(id).archived).toBe(false);
    await exited(m, id);
  });

  it('removeMany kills running sessions, deletes every folder and emits removed once per id', async () => {
    const m = manager();
    const a = m.start({ cwd: work, command: 'sh', args: ['-c', 'true'] });
    const b = m.start({ cwd: work, command: 'sleep', args: ['60'] });
    const keep = m.start({ cwd: work, command: 'sleep', args: ['60'] });
    await exited(m, a.id);
    const removed: string[] = [];
    m.onRemoved((id) => removed.push(id));

    await m.removeMany([a.id, b.id, a.id]);
    expect(removed.sort()).toEqual([a.id, b.id].sort());
    expect(m.list().map((s) => s.id)).toEqual([keep.id]);
    for (const id of [a.id, b.id]) expect(existsSync(join(base, 'sessions', id))).toBe(false);
    expect(existsSync(join(base, 'sessions', keep.id, 'meta.json'))).toBe(true);
  });

  it('removeMany with an unknown id deletes nothing', async () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'sleep', args: ['60'] });
    await expect(m.removeMany([id, '99999999-9999-4999-8999-999999999999'])).rejects.toThrow(/no such session/);
    expect(m.get(id)?.running).toBe(true);
    expect(existsSync(join(base, 'sessions', id))).toBe(true);
  });
});

describe('SessionManager — terminal title escapes', () => {
  // Reads one line per title from the terminal, sets it with OSC 2 and then prints `done:<line>` so a test knows it was processed.
  const TITLER = 'while read l; do printf "\\033]2;%s\\007" "$l"; echo "done:$l"; done';

  const until = async (m: SessionManager, id: string, line: string): Promise<void> => {
    for (let i = 0; i < 200 && !(await text(m, id)).includes(`done:${line}`); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await text(m, id)).toContain(`done:${line}`);
  };
  const set = async (m: SessionManager, id: string, line: string): Promise<void> => {
    m.write(id, `${line}\n`);
    await until(m, id, line);
  };
  const titler = (m: SessionManager): { id: string; changes: SessionInfo[] } => {
    const { id } = m.start({ cwd: work, command: 'sh', args: ['-c', TITLER] });
    const changes: SessionInfo[] = [];
    m.onChanged((session) => session.id === id && changes.push(session));
    return { id, changes };
  };

  it('an OSC 2 title replaces the title, persists meta.json and emits changed', async () => {
    const m = manager();
    const { id, changes } = titler(m);
    expect(m.get(id)).toMatchObject({ title: 'sh — work', titleSource: 'auto' });
    await set(m, id, 'Fix the build ✳');
    expect(m.get(id)).toMatchObject({ title: 'Fix the build ✳', titleSource: 'auto' });
    expect(readMeta(id)).toMatchObject({ title: 'Fix the build ✳', titleSource: 'auto' });
    expect(changes.map((session) => session.title)).toEqual(['Fix the build ✳']);
    expect(manager().get(id)?.title).toBe('Fix the build ✳');
  });

  it('caps the title at 200 characters', async () => {
    const m = manager();
    const { id } = titler(m);
    await set(m, id, 'z'.repeat(300));
    expect(m.get(id)?.title).toBe('z'.repeat(200));
  });

  it('a manual rename pins the title against later escape titles', async () => {
    const m = manager();
    const { id } = titler(m);
    await set(m, id, 'from program');
    expect(m.setTitle(id, '  Mine  ')).toMatchObject({ title: 'Mine', titleSource: 'manual' });
    await set(m, id, 'program again');
    expect(m.get(id)).toMatchObject({ title: 'Mine', titleSource: 'manual' });
    expect(readMeta(id)).toMatchObject({ title: 'Mine', titleSource: 'manual' });
  });

  it('releasing the pin lets the next escape title win', async () => {
    const m = manager();
    const { id, changes } = titler(m);
    m.setTitle(id, 'Mine');
    await set(m, id, 'ignored');
    expect(m.releaseTitle(id)).toMatchObject({ title: 'Mine', titleSource: 'auto' });
    expect(readMeta(id).titleSource).toBe('auto');
    await set(m, id, 'wins');
    expect(m.get(id)).toMatchObject({ title: 'wins', titleSource: 'auto' });
    expect(changes.map((session) => session.title)).toEqual(['Mine', 'Mine', 'wins']);
  });

  it('an identical title neither rewrites meta.json nor emits changed', async () => {
    const m = manager();
    const { id, changes } = titler(m);
    await set(m, id, 'same');
    const metaPath = join(base, 'sessions', id, 'meta.json');
    writeFileSync(metaPath, `${readFileSync(metaPath, 'utf8')} `); // a rewrite would drop this marker
    const before = readFileSync(metaPath, 'utf8');
    await set(m, id, 'same');
    expect(readFileSync(metaPath, 'utf8')).toBe(before);
    expect(changes).toHaveLength(1);
    await set(m, id, 'other');
    expect(changes.map((session) => session.title)).toEqual(['same', 'other']);
  });

  it('a session whose meta.json has no titleSource counts as auto', async () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'sh', args: ['-c', 'true'] });
    await exited(m, id);
    const metaPath = join(base, 'sessions', id, 'meta.json');
    const legacy = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    delete legacy.titleSource;
    writeFileSync(metaPath, JSON.stringify(legacy));
    expect(manager().get(id)?.titleSource).toBe('auto');
  });
});

describe('SessionManager — human-created sessions', () => {
  it('creates a session with no listener immediately and reports listeners: []', async () => {
    const m = manager();
    // The window's New Session path calls start() directly, with no listeners and no handshake.
    const created = m.start({ cwd: work, command: '/bin/sh', args: ['-c', 'true'] });
    expect(created.listeners).toEqual([]);
    expect(m.get(created.id)?.listeners).toEqual([]);
    expect(existsSync(join(base, 'sessions', created.id, 'listeners.json'))).toBe(false);
    const server = createApiServer({ service: m, token: 'human-path-token-0123456789abcdef', version: 't', startedAt: '2026-01-01T00:00:00.000Z' });
    const port = await listenOnLoopback(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/${created.id}`, { headers: { Authorization: 'Bearer human-path-token-0123456789abcdef' } });
      expect(response.status).toBe(200);
      expect(((await response.json()) as SessionInfo).listeners).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => void server.close(() => resolve()));
    }
    await exited(m, created.id);
  });
});
