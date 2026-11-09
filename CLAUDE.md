# Terminal Hub

Terminal Hub is a **terminal for agents**. Its primary user is an AI agent that starts a session, sends input, reads text back,
waits for a decision and kills it, usually with no human at the screen. The Electron window is a convenience layer: anything you
can do in the window must be reachable through the `hub` CLI and the local HTTP API.

## Rule: CLI and API first, GUI second

A command, a route and tests come before any button. Never add a feature that exists only as a button, menu item or IPC call.

## Eight design principles

1. **Two clients, one surface**: a feature that exists only as a button, menu item or IPC call is a bug.
2. **Non-interactive first**: every command finishes without a TTY, prompt or confirmation.
3. **Machine-readable where it matters**: `--json` on every read command and on errors, exactly one JSON value on stdout; a failure prints `{"error":"...","code":N}` to stderr.
4. **Stable identity**: a uuid that survives restart, resume, rename and archive; any unique prefix is accepted.
5. **Text on disk**: shell output is a readable file; an agent session history is its own transcript as plain text.
6. **Meaningful exit codes**: 0 ok, 1 error, 2 hub not running, 10 attention, 124 timeout, otherwise the child exit code.
7. **Self-describing**: `hub --help` lists commands, flags, exit codes and the data dir.
8. **No surprise interruption**: nothing kills or restarts a running session behind an agent's back.

## Repo map

- `src/main/`: Electron main process: pty + session store (`sessionManager.ts`, `sessionStore.ts`), the HTTP API (`apiServer.ts`, `service.ts`), `main.ts` (window, IPC, menu).
- `src/cli/`: the `hub` CLI (`hub.ts`), run with `bin/hub` after a build; bundled into the app by `scripts/build-cli.mjs`.
- `src/renderer/`: the Electron GUI (React + xterm.js). `src/preload/`: the IPC bridge. `src/shared/`: types used by all of them.
- `test/`: vitest. API tests boot `createApiServer` in-process with a mock `SessionService`; CLI tests bundle `src/cli/hub.ts` with esbuild and run it against that server.

## Commands

```
npm start            # build + launch the dev app
npm run build        # tsc + vite
npm test             # vitest
npm run lint         # eslint (typed)
npm run package:app  # build + electron-builder -> release/mac-arm64/Terminal Hub.app
npm run install:app  # package, then replace /Applications/Terminal Hub.app and the hub launcher
```

## Warning: one data dir, one API port file

Dev `npm start` and the packaged app share one data dir (`~/Library/Application Support/TerminalHub`, or `TERMINAL_HUB_DATA_DIR`)
and one `api.json` port file. **They must never run at the same time**, and never kill or restart a running app: its sessions are
live. To test the server or CLI without touching the running app, use the vitest suites or a separate `TERMINAL_HUB_DATA_DIR`.
