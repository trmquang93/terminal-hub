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

## Data

`~/Library/Application Support/TerminalHub/` (override with `TERMINAL_HUB_DATA_DIR`)

- `sessions/<uuid>/meta.json`, `output.log` (raw PTY bytes), `input.log`, `answers.log` (auto-answers)
- `token` (0600), `api.json` (0600, rewritten on start, removed on clean quit)

Nothing is pruned automatically. Deleting is explicit: *Delete session* (confirm), *Delete all history…* (confirm), `hub rm`.
Quitting stops running processes (SIGHUP, SIGKILL after 3 s), records the exit, keeps all files. They load as `interrupted`.

## Claude Code sessions

A command that runs `claude` (directly, via `env`, an absolute path, `npx …`) is started with `--session-id <uuid>`;
`meta.claude` records `configDir`, `sessionId`, `argvTemplate`, `resumeCommand`. **Resume** (button, `POST /sessions/:id/resume`,
`hub resume`) relaunches in the same entry with `claude --resume <uuid>` and the same cwd/env, appending to the same
`output.log` after a `── resumed … ──` line. Other commands get **Restart**. Nothing is ever resumed automatically.

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

`GET /health` · `GET /sessions[?attention=1]` · `POST /sessions` · `GET /sessions/:id` · `GET …/output?offset&limit` · `GET …/text?offset` ·
`GET …/stream` (SSE) · `GET /events` (SSE: attention + exit) · `POST …/input` · `POST …/answer` · `POST …/stop` · `POST …/resume` ·
`POST …/title` · `DELETE /sessions/:id` · `POST /hooks/claude`

## CLI

```
hub run [--cwd DIR] [--title T] [--unattended] [-q] -- CMD ARGS…   exits with the child's code
hub ls | text <id> [--follow] | send <id> "text" | stop <id> | rm <id> | resume <id> [--follow]
hub wait <id> [--timeout S]     exit 10 on attention (prints the question), child's code on exit, 124 on timeout
hub answer <id> yes|no|enter|esc|tab|up|down|1-9|<text>
hub notify-test                 send one synthetic attention event to the webhook in notify.json
```
