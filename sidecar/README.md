# phase.rs LLM opponent sidecar

A local-only micro API that lets the game play against a Claude Code session,
using your own subscription.

Full design notes, the authentication rules, and why this exists at all are in
[`docs/llm-opponent.md`](../docs/llm-opponent.md). This file is the operating
manual.

## Run it

```bash
cp .env.example .env          # then fill in CLAUDE_CODE_OAUTH_TOKEN
pnpm install
pnpm start                    # 127.0.0.1:8788
```

`pnpm dev` does the same with reload on edit. `pnpm test` runs the unit tests;
`pnpm typecheck` runs `tsc`.

Get a token with `claude setup-token`. Alternatively leave that variable empty
and point `CLAUDE_CONFIG_DIR` at a **writable** directory holding the
`.credentials.json` your `claude login` already wrote — the CLI rewrites that
file on OAuth refresh, so a read-only path works until the token ages out.

## API

All routes are under `/api/v1`. The Vite dev server proxies `/llm-opponent/*`
here, so the browser only ever sees a same-origin relative path.

### `GET /health`

```json
{ "status": "ok", "credential": "setup-token", "model": "claude-opus-5",
  "webSearch": false, "activeSeats": 1 }
```

`credential` reports which form is configured, never the credential itself. The
client probes this once to decide whether to offer the toggle.

### `POST /choose-action`

```json
{ "gameId": "…", "playerId": 1, "difficulty": "VeryHard",
  "waitingFor": "Priority", "state": { … }, "actions": [ … ] }
```

`state` and `actions` are the engine's own viewer-scoped output, forwarded
verbatim. Answers with:

```json
{ "actionIndex": 3, "reasoning": "…", "sessionId": "…", "durationMs": 8412 }
```

An **index** into the submitted list, never an action. Any non-200 means "not
this time" and the client falls back to the built-in AI:

| Status | Meaning |
|---|---|
| 400 | Malformed request |
| 413 | Board state over `LLM_OPPONENT_MAX_REQUEST_BYTES` |
| 422 | Too many actions offered, or Claude's answer was unusable |
| 502 | The CLI or the sidecar itself failed |

### `POST /end-game`

```json
{ "gameId": "…" }
```

Releases every seat's Claude session at that table. Idempotent — ending an unknown game
succeeds, because the client sends this on teardown paths that may fire before
any decision was ever requested.

## Smoke check

The unit tests stub the CLI, so they prove the wiring and none of the auth. To
confirm a real subscription works end to end:

```bash
pnpm start                                    # in one shell
curl -s localhost:8788/api/v1/health | jq     # expect "credential":"setup-token"
```

Then start the client (`pnpm dev` in `client/`), open AI opponent setup, and flip
the **Claude opponent** toggle — it is disabled with a reason until that health
probe succeeds. The sidecar logs one line per decision with the chosen index and
how long it took.

## Security

This process holds a credential and has no authentication of its own. Keep it on
loopback. `compose.yaml` binds `127.0.0.1:8788` for that reason; publishing it on
`0.0.0.0` hands anyone on the network a free Claude endpoint billed to you.
