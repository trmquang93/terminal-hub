# Per-session listeners and the create handshake

Status: design, 2026-11-09. Target: terminal-hub. No OpenMausBot-specific code in the core.

## Problem

Terminal Hub already hosts any command and already produces `attention`, `resolved` and `turn`
events, but it delivers them to one global endpoint (`notify.json` + `env`, read by
`createSender` in `src/main/notifyDelivery.ts`). A caller cannot say who it is, cannot register
its own destination, and a second agent cannot receive events without overwriting the global
config. OpenMausBot bot threads are also not addressable at all.

## The rule this design implements

- A session event is delivered **only** to listeners registered on that session.
- **No listener means no event.**
- A create with **no listener** is a valid session with zero listeners; it receives no events.

The first two are absolute. A create with a missing or empty `listeners` array — the desktop
window's New Session path, `POST /sessions` or `hub run` — starts immediately with zero listeners,
a valid state and not an error; the caller (or a person) can attach listeners later through the
same handshake. A create that does supply listeners is not created until every one has acked.

## 1. Listener object

A listener is a delivery target plus an event filter. A session has zero or more listeners;
each listener has its own filter. A listener is server-generated identity, not caller-chosen.

```json
{
  "id": "lst_7f3c1a2e",
  "kind": "openmausbot | http | command",
  "events": ["attention", "resolved", "turn", "exit"],
  "state": "pending | active | degraded | disabled",
  "createdAt": "2026-11-09T16:40:02.113Z",
  "acknowledgedAt": "2026-11-09T16:40:09.004Z",
  "endpoint": { }
}
```

`events` defaults to `["attention", "resolved", "turn", "exit"]` when absent or empty. Unknown
names are a 400. Event names are exactly the three existing ones plus `exit`.

`endpoint` differs per kind; the request and the read shape are not the same.

### Request shape (write)

```json
{ "kind": "http",
  "events": ["attention", "turn", "exit"],
  "http": { "url": "https://agent.example/hook", "bearer": "…", "headers": { "X-Run": "42" } } }
```

```json
{ "kind": "command",
  "events": ["attention", "exit"],
  "command": { "argv": ["/usr/bin/node", "/opt/agent/hook.mjs"], "cwd": "/opt/agent", "timeoutMs": 5000 } }
```

```json
{ "kind": "openmausbot",
  "events": ["attention", "turn", "exit"],
  "openmausbot": { "botId": "5cea84fc-b23e-4643-90ba-f9a1d572380d", "threadId": "thread-abc" } }
```

- `http`: `url` must be `http:` or `https:`. `bearer` is optional and becomes
  `Authorization: Bearer …`. `headers` is an optional object of strings.
- `command`: `argv` is an array, never a shell string; spawned with `shell: false`.
  `cwd` defaults to the session cwd. `timeoutMs` defaults to 5000 and is capped at 60000.
  It receives one JSON object plus `\n` on stdin; stdout is read only for the ack line.
- `openmausbot`: `botId` and `threadId` are opaque strings. The core never interprets them;
  the OMB side supplies the transport (section 4).

Validation: exactly one kind, exactly one matching endpoint block, no other keys in the object
(unknown top-level keys are a 400 so a typo cannot silently drop a filter).

### Read shape (redacted)

`GET /sessions[/:id]` and `hub listeners --json` never return a secret or a full URL:

```json
{ "id": "lst_7f3c1a2e", "kind": "http", "events": ["attention"], "state": "active",
  "host": "agent.example", "pending": 0, "failed": 0, "lastError": null }
```

`command` shows the basename of `argv[0]` and `argv.length`; `openmausbot` shows `botId` and
`threadId` (identifiers, not secrets). Logs use the same rule: host or basename only.

### Persistence

`sessions/<id>/listeners.json`, mode 0600 (it can hold a bearer or headers), rewritten atomically.
Deleted with the session folder. No listener state lives in `meta.json`, so an old `meta.json`
loads unchanged and a session without listeners simply has no file.

## 2. Handshake: a listener is not registered until it answers

Registration is a handshake, not fire-and-forget. A listener is not active until it acknowledges
a one-time token, and a create that supplies listeners is not created until every one has acked.

### Test event

Immediately after a listener is validated, the hub sends one event to it:

```json
{
  "event": "handshake",
  "handshakeId": "hs_9b1d…",
  "token": "…32 random bytes, base64url…",
  "expiresAt": "2026-11-09T16:40:32.113Z",
  "instructions": {
    "cli": "hub ack hs_9b1d… <token>",
    "http": "POST http://127.0.0.1:PORT/handshakes/hs_9b1d…/ack  {\"token\":\"<token>\"}"
  },
  "listener": { "kind": "http", "events": ["attention"] },
  "sessionRequest": { "cwd": "/path", "command": "claude", "title": "…" },
  "testEvent": true
}
```

The test event carries nothing secret about the session (the session does not exist yet) and no
API token. The ack token is the only credential in it.

### States and timeouts

`<data dir>/handshakes/<handshake-id>.json`, mode 0600, holds the SHA-256 of the token and the
validated create/listen request. A handshake goes through:

| state | meaning |
| --- | --- |
| `pending` | test event is being delivered / retried |
| `acked` | the token matched; the session is being created |
| `created` | session exists; the handshake record is then deleted |
| `expired` | no ack before the deadline |
| `failed` | the test event could not be delivered at all (every retry failed) |
| `cancelled` | the caller went away / `hub` was killed |

- Default ack deadline: **30 s**, per-listener override `ackTimeoutSec` (1–300 s), counted from
  the moment the test event is first sent.
- All listeners of one create are handshaken **in parallel**, sharing one deadline. The session is
  created only when every listener reaches `acked`.
- Any listener that expires or fails cancels the whole create: the other handshakes are
  cancelled, every handshake file is deleted, and no session folder, `meta.json` or pty is left
  behind.
- `POST /handshakes/:id/ack` is the only route exempt from the API bearer check: the one-time
  token is the credential. Comparison is constant-time, single-use, and after `expiresAt` the
  route answers 410. It is still loopback-only (same host check as every other route).
- `hub ack <handshake-id> <token>` uses the local `api.json` bearer, prints one JSON value with
  `--json`, exit 0 on accepted, 1 on a bad/expired/used token.

### Create sequence

1. Caller sends `POST /sessions` (or `hub run`), optionally with listeners.
2. Hub validates (400 on a malformed listener, before any side effect).
3. Hub writes one handshake per listener and sends every test event in parallel.
4. Each listener acknowledges through the CLI or the HTTP route.
5. When all are `acked` the hub calls the existing `SessionManager.start`, stores
   `listeners.json`, and marks the listeners `active`.
6. Response: `201 { "id": "…", "listeners": [{ "id": "lst_…", "handshakeId": "hs_…" }] }`.

`POST /sessions` blocks until the handshake settles by default. `{ "wait": false }` returns
`202 { "handshakeId": "…", "expiresAt": "…", "state": "pending" }` and the caller polls
`GET /handshakes/:id`. On timeout/failure the blocking form answers `504` with
`{"error":"listener did not acknowledge","handshakes":[{…}]}`; the fast form settles the same way.

### Adding a listener to a running session

Same call, same handshake:

```
hub listen <session> --listen '{"kind":"http","url":"…","events":["attention"]}'
POST /sessions/:id/listeners   (same body, same 202/504 rules)
```

The listener is appended only after it acks. A timeout leaves the running session untouched and
returns the same error. `hub listen` blocks by default; `--no-wait` returns the handshake id.
Removing a listener (`DELETE /sessions/:id/listeners/:listenerId`, `hub listeners rm`) takes
effect immediately and deletes its cursor.

### Sessions with no listeners

A create with zero listeners is immediate and needs no handshake:

- The session exists at once with **zero listeners**. `listeners` is `[]` on `GET /sessions/:id`,
  `hub listeners` prints an empty list and exits 0, and no handshake is started. This is a valid
  state, never an error.
- It emits no network events while it has no listener, exactly as the core rule says.
- The person (or an agent they tell the id to) can attach a listener later with
  `hub listen <id> …` or `POST /sessions/:id/listeners`; the same handshake rules apply.
- A listener can also be added to a running session from an agent; nothing else about the session
  changes.

This applies to the desktop window's New Session path (IPC `hub:create`) and to `POST /sessions`
or `hub run` when `listeners` is missing or empty. `hub listen` still needs exactly one listener,
and a create with several listeners still waits for all of them.

## 3. Event envelope and journal

One envelope, identical on every transport:

```json
{ "eventId": "evt_2b…", "seq": 17, "event": "attention",
  "at": "2026-11-09T16:40:02.113Z",
  "session": { "id": "8f0c…", "title": "…", "cwd": "/path", "command": "claude",
               "state": "running", "exitCode": null },
  "attention": { "reason": "prompt", "promptText": "…", "source": "heuristic", "since": "…" },
  "turn": null }
```

Fields not relevant to the event are omitted (`turn` is an object only for `turn` events, and so
on). `promptText` keeps the existing 4000-char cap and the API-token scrub. No env, argv, full
listener endpoint or token ever appears.

Every emitted event is appended once to `sessions/<id>/events.jsonl` with a persisted,
monotonically increasing `seq`, whether or not a listener is currently alive. The journal is
capped at 5000 lines / 1 MB, trimmed oldest first. This is what makes `hub events --since` work
across app restarts and after a listener was down.

## 4. Delivery drivers

`AttentionNotifier` stays the event source: it already turns session changes into one
`attention` per prompt, one `resolved`, one `turn` per real transition, ordered per session. Its
`send` is replaced by a per-session dispatcher that fans one event out to that session's matching
listeners, each through its own ordered queue.

Every listener has a durable cursor
(`sessions/<id>/listeners/<listenerId>/cursor.json`) and an attempt log
(`deliveries.jsonl`). Delivery is at-least-once per listener; `eventId` is the dedupe key.

### http

Reuse `deliver()` from `src/main/notifyDelivery.ts` (5 s timeout, `redirect: "manual"`,
`AbortSignal.timeout`). 2xx is delivered. 429, 5xx and network errors are retried; other 4xx and
redirects are final for that attempt but the event stays in the journal.

### command

Spawn `argv` with `shell: false`, cwd from the listener or the session, one JSON line on stdin,
stdout/stderr capped at 64 KB. Exit 0 = delivered. A non-zero exit, spawn error or timeout is a
failed attempt. Timeout: `timeoutMs` (default 5000, max 60000), SIGTERM then SIGKILL.

A command listener may also acknowledge the handshake by printing `{"ack":"<token>"}` as its
first stdout line; otherwise it calls `hub ack`. Exit 0 alone is **not** an ack.

### openmausbot (adapter seam)

The core cannot and must not know OpenMausBot internals. The driver spools the envelope to
`<data dir>/outbox/openmausbot/<botId>/<threadId>/<eventId>.json` (atomic write) and then runs
the configured bridge command:

```json
// <data dir>/omb-bridge.json, mode 0600, optional
{ "command": ["/usr/local/bin/omb-event-bridge"], "timeoutMs": 5000 }
```

The bridge gets `{ "botId", "threadId", "eventPath" }` on stdin and exits 0 when OMB has accepted
it into that exact thread. A non-zero exit or timeout is a failed attempt, retried like any
other driver. This is the single OMB-specific piece and it lives on the OMB side; without a
configured bridge an `openmausbot` listener is `disabled` with a clear error at create time
(400, not a silent create).

The bridge must not auto-ack. The bot in the thread acks the handshake itself (it has a shell),
which is what proves the exact bot and thread received it.

## 5. Failure, retry and visibility

- Attempt backoff per listener: `0.5, 1.5, 4, 10, 30` s, **6 attempts**, then the event is marked
  `failed` for that listener and remains in `events.jsonl`. A failed event is never dropped
  silently: it is counted, logged and listed by `hub events`.
- A listener with 3 consecutive failed events becomes `degraded`; a success returns it to
  `active`. `hub listeners` and `GET /sessions/:id/listeners` show `pending`, `failed`,
  `lastError` and `lastDeliveryAt`.
- On app start, listeners reload from disk and each queue resumes from its cursor; a `degraded`
  listener is retried again (state resets to `active` only after the first success).
- Nothing waits for a listener: no PTY loop, no input, no UI. A bounded in-memory queue (1000 per
  listener) overflows to `failed`, never to a silent drop.
- Every attempt is one record: `{deliveryId, listenerId, eventId, seq, attempt, startedAt,
  durationMs, outcome, status, error}` in `deliveries.jsonl` (trimmed to 2000 lines per listener).
  `outcome` is `delivered | http_error | timeout | spawn_error | nonzero_exit | bridge_error`.

## 6. CLI surface

All non-interactive; `--json` on every read command; errors as `{"error":"…","code":N}` on stderr.

```
hub run [--cwd DIR] [--title T] [--unattended] [--json] [--detach|--wait]
        [--listen SPEC]... [--listen-file PATH]... [--ack-timeout S]
        -- CMD ARGS…
hub listen <session> --listen SPEC [--listen-file PATH] [--ack-timeout S] [--json] [--no-wait]
hub ack <handshake-id> <token> [--json]
hub listeners <session> [--json]
hub listeners rm <session> <listener-id>
hub listeners resume <session> <listener-id>
hub events <session> [--since SEQ] [--follow] [--json]
hub deliveries <session> [--listener ID] [--limit N] [--json]
```

`SPEC` is a compact grammar, documented in `--help`:

- `omb:<botId>/<threadId>` → `openmausbot`
- `http:<url>` → `http`
- `cmd:<argv0>[,<arg>…]` → `command`
- suffix `#events=attention,turn,exit` sets the filter (default: all)
- `http` extras: `#header=Name:Value` (repeatable), `#bearer-env=VAR` (never put a token in
  shell history; `--listen-file` is the other way)

`--listen-file` takes a JSON file with one listener object (mode 0600) for any endpoint with
secrets. Repeat flags are additive. `hub listen` needs a running session; `hub ack` does not need
the app to still hold the handshake if it already expired.

`hub run` waits for the handshake before the command starts, so the returned id always has a
live process. `--no-wait` is not offered on `run`: a session must not exist before its listener
acked.

## 7. HTTP API

- `POST /sessions` — body gains `listeners: [...]` and `wait?: boolean` (default `true`).
  201 with `{id, listeners}` after ack; 202 `{handshakeId, expiresAt, state}` with
  `wait:false`; 400 on validation; 504 on a handshake timeout/failure; **400 if `listeners` is
  missing or empty**.
- `POST /sessions/:id/listeners` — same body, same 201/202/504 rules; adds to a running session.
- `GET /sessions/:id/listeners` — redacted list + counters.
- `DELETE /sessions/:id/listeners/:listenerId` — remove.
- `POST /handshakes/:id/ack` `{token}` — the only bearer-exempt route; 200, 401/410/404.
- `GET /handshakes/:id` — state and, once created, the session id.
- `GET /sessions/:id/events?since=SEQ&limit=N` — `{events:[…], next: SEQ}`.
- `GET /sessions/:id/deliveries?listener=&limit=` — attempt records.
- Unchanged: `GET /sessions`, `GET /events` (SSE), `/stream`, `/text`, the hooks route. They only
  gain the redacted `listeners` field on a session.

## 8. Worked examples

### An OpenMausBot bot thread

The bot's own shell (from its thread) registers the session and acks:

```
hub run --detach --cwd /Volumes/T7/Projects/open-source/terminal-hub \
  --listen 'omb:5cea84fc-b23e-4643-90ba-f9a1d572380d/thread-abc#events=attention,turn,exit' \
  -- claude
```

1. `hub run` prints nothing yet; the hub sends the handshake event through the OMB bridge to that
   bot id and thread id.
2. The bot reads the event in its thread and runs `hub ack hs_9b1d… <token>`.
3. `hub run` prints the session id and starts `claude`. `attention`, `turn` and `exit` events now
   arrive in the same thread; the bot answers with `hub answer <id> …`.

A bot that only wants to attach to a running session uses the same handshake:

```
hub listen 8f0c1d2e --listen 'omb:<botId>/<threadId>#events=attention'
```

### A plain Node agent, no OMB

```js
// 1. It runs a tiny local server, then registers; the POST blocks until the ack.
const api = JSON.parse(fs.readFileSync(apiJsonPath, 'utf8')); // baseUrl + token

app.post('/hub', async (req, res) => {
  res.sendStatus(204);
  if (req.body.event === 'handshake') {
    await fetch(`${api.baseUrl}/handshakes/${req.body.handshakeId}/ack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: req.body.token }),
    });
    return;
  }
  if (req.body.event === 'attention') await answer(req.body.session.id, 'enter');
});

const created = await fetch(`${api.baseUrl}/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    cwd: '/work/repo', command: 'claude',
    listeners: [{ kind: 'http', http: { url: 'http://127.0.0.1:8787/hub' },
                  events: ['attention', 'turn', 'exit'] }],
  }),
});
const { id } = await created.json(); // 201 only after the ack
```

Reconnect: `hub events <id> --since <last seq>` replays what was missed; the listener's own
cursor does the same for redelivery.

### A CLI-only agent using a command listener

```
hub run --listen 'cmd:/usr/bin/node,/opt/qa/hook.mjs#events=attention,exit' -- claude
```

`hook.mjs` reads one JSON object from stdin; on `event === "handshake"` it prints
`{"ack":"<token>"}` (or shells out to `hub ack`), and on later events it answers the prompt.
Exit 0 on the handshake without that line is not an ack.

## 9. GUI: session context menu with "Copy Session ID"

Right-clicking a session row opens a context menu; the required item is **Copy Session ID**,
which copies `session.id` to the clipboard. This is a convenience over an existing value, not a
new capability: the copied string is exactly the stable uuid returned as `id` by
`GET /sessions[/:id]` and `hub ls --json`, accepted as an id or unique prefix by every `hub`
command, and used unchanged by the HTTP API. No new IPC-only feature is introduced.

- Renderer-only: `navigator.clipboard.writeText(session.id)` in `src/renderer/App.tsx`; no new
  IPC channel and no change to the CLI/API surface.
- `SessionRow` gains `onContextMenu` and a small menu positioned at the pointer (dismissed by
  Escape, a click elsewhere, or a second right-click). Keyboard equivalent: the row's existing
  `title` should mention the id is available from the menu, and the menu is reachable with the
  context-menu key or Shift+F10 when the row has focus.
- Reuse the existing handlers for the other items so the menu is not a second code path:
  `Copy Session ID`, `Rename…` (same as the double-click pin), `Archive`/`Unarchive`, `Delete`
  (existing `onDelete`/`onArchive` callbacks, same behaviour and no confirmation).
- The menu works in Select mode too: right-click on a row copies that row's id without toggling
  the selection.
- No id is displayed or logged anywhere else; the menu is the only new surface.

## 10. Code map (for implementation)

- `src/shared/types.ts` — `ListenerKind`, `ListenerRequest`, `ListenerInfo`, `EventName`,
  `HubEvent`, `HandshakeState`, `DeliveryRecord`; `StartSessionOptions.listeners`.
- `src/main/listenerConfig.ts` (new) — validate, redact, atomic 0600 write to
  `sessions/<id>/listeners.json`.
- `src/main/handshake.ts` (new) — token generate/hash, `<data dir>/handshakes/*.json`, expiry
  timer, ack, cancel, settle.
- `src/main/eventJournal.ts` (new) — `events.jsonl` append/read/trim, per-session `seq`.
- `src/main/eventDelivery.ts` (new) — per-listener ordered queue, three drivers, attempt log,
  backoff, degraded state, start-up resume.
- `src/main/service.ts` — `SessionService` gains the listener and handshake operations.
- `src/main/sessionManager.ts` — `start()` takes listeners (or the caller stores them right after
  the ack, before spawn); `remove()` deletes the listener dir; `resume()` keeps listeners.
- `src/main/apiServer.ts` — routes of section 7; bearer-exempt ack route with token check.
- `src/main/main.ts` — wire `AttentionNotifier.send` to the dispatcher; load `omb-bridge.json`.
- `src/cli/hub.ts` — commands/flags of section 6, `--help`, README.
- `src/renderer/App.tsx` — session context menu of section 9 (`SessionRow`, `Copy Session ID`,
  reuse the existing rename/archive/delete handlers).
- `test/` — validation, handshake success/timeout/single-use, ack authorization, three drivers
  with mock fetch/spawn, retry and degraded state, journal seq/trim, create-with-zero-listeners
  is 400 and leaves no folder, listener add to a running session, CLI parsing.
- `README.md` — replace the single-endpoint webhook section with this model plus one example.

## 11. Compatibility

- `notify.json` / `TERMINAL_HUB_NOTIFY_*` no longer feed session events; `hub notify-test` keeps
  working against it until it is removed in a follow-up.
- `GET /sessions`, `GET /events`, `/stream`, `/text` and the hooks route keep their shape; a
  session gains a redacted `listeners` array.
- A session created before this change has no `listeners.json` and emits no events; it can gain a
  listener with `hub listen` and its next events are delivered from then on.
- Nothing new exists only in the Electron window.

## Open questions

1. **OMB transport.** The `openmausbot` driver assumes an OMB-side bridge command that accepts an
   event into a bot thread. If OMB has no such injection point, OMB bots must register `http`
   or `command` listeners instead; the kind then exists only as an alias for a bridge. Which is
   true needs an answer from the OpenMausBot side.
2. **All-or-nothing handshake.** One create with three listeners requires all three to ack within
   one 30 s deadline. Alternative: create when the first acks and let the rest attach later.
   Proposed: all (a session with a listener that never got the event is the failure mode we are
   removing).
3. **Retention of failed deliveries.** Failed events stay in the journal (5000 lines / 1 MB cap).
   Should a dead listener's backlog ever be dropped, or only capped by the journal trim? Proposed:
   only the journal trim, with counters that survive in `deliveries.jsonl`.
4. **`command` ack on stdout.** Allowing `{"ack":"<token>"}` on stdout is convenient but means a
   chatty script could ack by accident if it printed that line for another reason. Proposed: keep
   it, since the token is random and one-time.
5. **Bearer on the CLI.** A URL with a bearer in argv lands in shell history. Proposed: only
   `#bearer-env=VAR` and `--listen-file`, never a literal token on the command line.
6. **Restart of a running session.** `hub resume` keeps the stored listeners and re-sends no
   handshake (the listener already proved it works). Proposed: keep, and list it here because a
   listener that stopped existing during a restart is only discovered on its next event.
