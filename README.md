# Terminal Hub

macOS desktop app (Electron + TypeScript + React + node-pty + xterm.js) that hosts real terminals.
Every session is written to disk and stays in the list until you delete it by hand.

```
npm install      # also fetches the Electron binary
npm start        # build + launch
npm test         # vitest
npm run lint     # eslint (typed)
npm run build    # tsc + vite
npm link         # optional: puts `hub` on your PATH (or run ./bin/hub)
```

## Install as a Mac app

```
npm run package:app   # build + electron-builder → release/mac-arm64/Terminal Hub.app (unsigned, arm64)
npm run install:app   # package, then replace /Applications/Terminal Hub.app and install the `hub` launcher
```

- The app lives at `/Applications/Terminal Hub.app` (open it from Spotlight). `install:app` removes the old bundle first and
  refuses to run while the app is running (quit it first: running sessions would be interrupted). The copy is ad-hoc signed.
- `hub` is a small shell launcher at `/opt/homebrew/bin/hub` (no PATH edits) that runs
  `node "/Applications/Terminal Hub.app/Contents/Resources/hub/hub.cjs"`, a self-contained bundle of `src/cli/hub.ts`
  (`scripts/build-cli.mjs`). It does not need this folder. If the app is moved or deleted it says so and exits 127.
  Re-running `install:app` rewrites it. Override targets with `HUB_APPS_DIR` / `HUB_BIN_DIR`.
- **Dev (`npm start`) and the packaged app share the same data dir and API port file. Do not run both at once**
  (or give one of them its own `TERMINAL_HUB_DATA_DIR`).
- First launch from Spotlight may show a macOS prompt about files on a removable volume if a login-shell rc file touches `/Volumes`.

## Automatic updates

The installed app updates itself from the git checkout it was built from, **only when no session is running**. It never quits
the app while a session is live: a running session blocks every step, and the check is repeated right before the quit.

- **Source (first match wins):** `update.json` `repo` in the data dir → `build-info.json` in the app's Resources (written by
  `scripts/build-info.mjs` during `package:app`; holds the repo path, commit, branch) → the current directory when it is a
  terminal-hub checkout (dev). A bad or missing source turns auto-update off with one `WARN` line in `update.log`; it never throws.
- **`update.json`** (optional, `<data dir>/update.json`; every key optional):

  ```json
  { "repo": "/Users/me/terminal-hub", "branch": "main", "checkMinutes": 5, "enabled": true }
  ```

  Defaults: branch `main`, every 5 minutes, enabled. `"enabled": false` switches it off. A malformed file switches it off.
- **Each check:** `git fetch origin <branch>`, then reads `HEAD`, the current branch, `git status --porcelain` and
  `git rev-list --count HEAD..origin/<branch>`. Nothing happens on a dirty tree, a different branch, a failed fetch, or 0 commits behind.
- **Idle rule:** when behind, the app waits until no session has been running for 30 s (a session that starts resets the clock).
  The header chip shows `update available (N) - waits for idle`, then `updating...`, or `update failed`. No dialog.
- **Update:** `git pull --ff-only origin <branch>` → `npm ci` (only if `package-lock.json` changed) → `npm run package:app` →
  check that `release/mac-arm64/Terminal Hub.app` exists → re-check that no session runs → quit through the normal shutdown and
  start one detached `/bin/sh` that waits up to 30 s for the app to exit, runs `node scripts/install-app.mjs`, then
  `open -a "/Applications/Terminal Hub.app"`. A step that fails is logged (command + stderr), the app keeps running, and
  the next check retries from that step. Only a packaged app installs; `npm start` just logs.
- **Log:** `update.log` in the data dir, rotated to `update.log.1` at 1 MB.
- **Dry run:** `TERMINAL_HUB_UPDATE_DRY_RUN=1` logs every pull / npm / build / install / open command as `DRY-RUN would run: …`,
  executes none of them and never quits. (The read-only check still runs `git fetch`, which only updates `origin/<branch>`.)

## Data

`~/Library/Application Support/TerminalHub/` (override with `TERMINAL_HUB_DATA_DIR`)

- `sessions/<uuid>/meta.json`, `output.log` (raw PTY bytes), `input.log`, `answers.log` (auto-answers)
- `token` (0600), `api.json` (0600, rewritten on start, removed on clean quit), `update.json` (optional), `update.log`

Nothing is pruned automatically. Deleting is explicit: *Delete session* (the ×) and *Delete selected* delete at once with no
confirmation, `hub rm` and `POST /sessions/delete` likewise; only *Delete all history…* asks first.
Quitting stops running processes (SIGHUP, SIGKILL after 3 s), records the exit, keeps all files. They load as `interrupted`.

## Sidebar: groups, archive, select

- Sessions are grouped by working folder (header: folder name + shortened path). A group with a running or waiting session
  sits above idle groups; otherwise groups are ordered by their newest session, and sessions inside a group newest first.
- **Archive** hides a finished session in the collapsed *Archived (N)* section at the bottom (click to expand). Archived rows can
  still be opened (output replay), unarchived and deleted. `meta.json` carries `archived: boolean` (missing = `false`);
  a running session cannot be archived (400), and resuming an archived session unarchives it. New sessions are never archived.
- **Select** switches the rows to checkboxes (a row click toggles instead of opening). The header shows `N selected`,
  *Delete selected* and *Cancel*. Running sessions in the selection are killed, then every folder is removed. No confirmation.

## Claude Code sessions

A command that runs `claude` (directly, via `env`, an absolute path, `npx …`) is started with `--session-id <uuid>`;
`meta.claude` records `configDir`, `sessionId`, `argvTemplate`, `resumeCommand`. **Resume** (button, `POST /sessions/:id/resume`,
`hub resume`) relaunches in the same entry with `claude --resume <uuid>` and the same cwd/env, appending to the same
`output.log` after a `── resumed … ──` line. Other commands get **Restart**. Nothing is ever resumed automatically.

## OpenCode sessions

The **OpenCode (opencode)** preset starts `opencode`; the same detection covers `env`, an absolute path, `npx opencode-ai …`.
opencode cannot be given a session id at launch and creates none until the first message is sent, so `meta.claude.sessionId`
stays empty until then: the app polls opencode's SQLite store (`$XDG_DATA_HOME/opencode/opencode.db`, default
`~/.local/share/opencode/opencode.db`, read with the system `sqlite3`) for the newest top-level session created in the same
cwd, and records its `ses_…` id. **Resume** relaunches with `opencode --session <id>` and the same cwd/env. Until an id exists
(no message sent yet) the session cannot be resumed. A user `-s/--session` or `-c/--continue` in the command is stripped
from the resume command.

The app never edits Claude's settings (`settings.json`, hooks): attention is detected from the screen text alone.

## Needs attention

Per session `attention: { reason: "prompt"|"idle", promptText, since, source: "hook"|"heuristic"|"idle" }`, from a screen-text
heuristic (`Do you want to proceed?`, `❯ 1.`, `[y/N]`, …) and a 20 s idle fallback (`source: "hook"` only appears if you wire up
`hub hook-notify` as a Claude `Notification` hook yourself; the app does not). Shown as a red badge, toast,
question panel with quick keys, and a throttled macOS notification.

`POST /sessions/:id/answer` `{ "keys": "1\r" }` or `{ "text": "yes", "submit": true }` (names: yes no enter esc tab up down 1–9).
Per-session `autoAnswer` policy (off by default; `unattended: true` = approve `Do you want to proceed?` with Enter only).

## Push notifications (webhook)

When a session starts waiting for a decision, or stops, the app POSTs the event to your endpoint, so an assistant can be woken
up and reply with `hub answer <id> …` instead of polling. Create `~/Library/Application Support/TerminalHub/notify.json`
(under `TERMINAL_HUB_DATA_DIR` when set):

```json
{ "url": "http://127.0.0.1:PORT/hooks/xxx", "bearer": "secret-or-empty" }
```

- The file is read again for every send: edit it, no restart. Fallback when it has no usable `url`:
  env `TERMINAL_HUB_NOTIFY_URL` / `TERMINAL_HUB_NOTIFY_BEARER` (set for the app process). One source is used whole.
  No url anywhere = feature off. A garbage file is ignored with a warning in the log.
- `POST <url>`, `Content-Type: application/json`, plus `Authorization: Bearer <bearer>` only when `bearer` is non-empty:

```json
{
  "event": "attention",
  "session": {
    "id": "…", "title": "…", "cwd": "/path", "command": "sh", "state": "running",
    "reason": "prompt", "promptText": "Continue? [y/N]", "source": "heuristic", "since": "2026-11-08T07:00:00.000Z"
  }
}
```

  `event` is `attention` or `resolved`. `resolved` repeats the question that was reported (same `since`) and the session's
  current `state` (`exited` when the process ended). Only these fields are sent: never the API token (also scrubbed from the
  question text), `api.json`, env, argv or the output. `promptText` is the last ~10 plain-text lines, capped at 4000 chars.
- **When:** once per question. `attention` goes out when a `prompt` has been on screen for 1 s (redraws and blinking do not
  repeat it; a prompt that vanishes inside that second is never sent); `resolved` when it is answered or scrolls away, or when the
  session exits. The 20 s `idle` fallback is not pushed. A prompt that the session's `autoAnswer` policy has a rule for is
  answered by the app and not pushed. The 30 s per-session throttle applies to the macOS banner only.
- **Delivery:** 5 s timeout, up to 3 attempts (waits of 0.5 s and 1.5 s) for network errors, timeouts, 5xx and 429; other 4xx
  and redirects are final. A session's events are sent in order; nothing waits for the endpoint (not the PTY loop, not the UI).
  An unreachable endpoint is a `WARN` line, nothing else. On quit the app gives final events up to 2 s.
- **Log:** `notifications.log` in the data dir, one line per attempt and one per failure (host only, never the URL path or
  bearer). At 1 MB it rotates to `notifications.log.1`.
- **Test it:** `hub notify-test` sends one synthetic `attention` event (`id: "notify-test"`) to the configured endpoint, one
  attempt, and prints the HTTP status (exit 1 on failure). It does not need the app to be running.

## HTTP API (127.0.0.1, `Authorization: Bearer <token>` except `/health`)

`GET /health` · `GET /sessions[?attention=1]` (includes archived sessions; each has `archived`) · `POST /sessions` · `GET /sessions/:id` · `GET …/output?offset&limit` · `GET …/text?offset` ·
`GET …/stream` (SSE) · `GET /events` (SSE: attention + exit) · `POST …/input` · `POST …/answer` · `POST …/stop` · `POST …/resume` ·
`POST …/title` · `POST …/archive` `{ "archived": true|false }` (returns the session; 400 while it runs) · `DELETE /sessions/:id` ·
`POST /sessions/delete` `{ "ids": [...] }` (no confirmation; kills running ones; 404 and nothing deleted if an id is unknown) · `POST /hooks/claude`

## CLI

```
hub run [--cwd DIR] [--title T] [--unattended] [-q] -- CMD ARGS…   exits with the child's code
hub ls                          marks archived sessions in an ARCHIVED column
hub text <id> [--follow] | send <id> "text" | stop <id> | rm <id> | resume <id> [--follow]
hub archive <id> | unarchive <id>
hub wait <id> [--timeout S]     exit 10 on attention (prints the question), child's code on exit, 124 on timeout
hub answer <id> yes|no|enter|esc|tab|up|down|1-9|<text>
hub notify-test                 send one synthetic attention event to the webhook in notify.json
```
