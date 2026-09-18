# LLM opponent (local only)

Play against Claude instead of the built-in AI, using your own Claude
subscription.

**This is a local development branch feature and is never merged upstream.** It
exists on `claude/llm-opponent-sidecar-ihdd4e` and nowhere else. The reason is
the credential: making it work means running a process that holds a Claude
subscription token, and there is no version of that which belongs in a shipped
game client.

## Why a sidecar

A browser cannot use a Claude subscription. Subscription auth is an OAuth token
that the Anthropic API accepts only from the Claude Code client, so a direct
`fetch` from the page to `api.anthropic.com` fails no matter how the token is
passed. Embedding an API key in the client instead would work technically and is
the wrong trade: it bills a Console account rather than the subscription, and the
key ships to every browser that loads the page.

The sidecar resolves this by being the Claude Code client. It runs on the
developer's own machine, holds the credential, and speaks to the page over
loopback.

## Shape

```
browser ──/llm-opponent/*──▶ Vite proxy ──▶ sidecar :8788 ──▶ Claude Code CLI ──▶ Anthropic
```

The sidecar is `sidecar/`, a Node service built on
`@anthropic-ai/claude-agent-sdk`, which vendors the Claude Code CLI. It is not
the plain `@anthropic-ai/sdk`: that package talks to the Messages API directly
and cannot use a subscription token.

## What the sidecar decides, and what it cannot

The engine remains the only authority. For each decision:

1. The adapter asks the engine for `getViewerSnapshot(playerId)` — the seat's
   redacted state plus its legal actions.
2. It forwards both verbatim to the sidecar. The client transforms nothing; a
   redaction or summary written there would be a second, drifting copy of the
   engine's.
3. Claude answers with an **index** into that action list, never an action.
4. The adapter feeds `[[actions[index], 1]]` to
   `get_ai_action_proposal_from_scores`, which issues a fresh
   `AiDecisionContract` against the state as it stands *now*, drops any scored
   action the contract does not admit, and returns null if nothing survives.

The consequence is that the worst decision Claude can produce is a legal but bad
one. It cannot invent an action, target something the seat cannot see, or make a
choice the engine would have to validate after the fact. A decision made against
a snapshot that has since moved on is discarded by the engine, not submitted.

Every failure — sidecar down, timeout, malformed answer, out-of-range index,
stale contract — falls through to the built-in AI for that one decision. The game
never blocks on the sidecar.

## Which decisions route

Claude answers every kind of engine decision except a small, closed set of
mechanical ones, listed in `LLM_OPPONENT_UNROUTED_WAITING_FOR`:

| Excluded | Why |
|---|---|
| `ManaPayment`, `ManaSourceSelection` | Choosing which lands to tap carries almost no strategic content, and the pair fires several times per spell. Routing them would turn casting a five-drop into a minute of round-trips for a result the engine already gets right. |
| `ResolveAllConsent`, `ResolveAllReady` | Protocol consent, not a play decision. |
| `GameOver` | Nothing to decide. |

A denylist rather than an allowlist on purpose: `WaitingFor` has forty-odd
variants and grows with every mechanic, and an allowlist would silently stop
routing each new kind of decision — the opposite of what this feature is for.

## Cost gate

Most priority windows in Magic offer nothing but a pass. The adapter consults the
sidecar only when the engine's own `autoPassRecommended` is false **and** at
least `LLM_OPPONENT_MIN_ACTIONS` actions are offered. Without this gate a turn
would take minutes and spend a subscription on foregone conclusions.

The sidecar declines a window offering more than `MAX_OFFERED_ACTIONS` actions;
past that point the list is a permutation explosion the engine's own shortcut
handles better than prose can.

## Sessions

One Claude session per **seat**, keyed by `<gameId>:<playerId>`. The game id is
minted on every `resetGameState()`. Decisions for a seat resume its session, so
Claude remembers the plan it committed to two turns ago.

Per seat rather than per game because a multiplayer table runs several AI seats
at once, and one shared transcript would leave seat 2 reading seat 1's
redacted-but-visible hand out of the conversation history — the engine's
per-viewer redaction, undone by the memory sitting above it.

Decisions for one seat are serialized: a resumable session has a single linear
transcript, and two decisions resuming the same id concurrently would race to
append to it. The sidecar aborts a decision at `DECISION_TIMEOUT_MS` (110s, just
under the client's budget), because a query that never returns would otherwise
hold that seat's lock forever and every later decision would queue behind it.

Every seat's session is released when the game resets or the toggle is turned
off.

## Authentication

The CLI resolves credentials in this order:

1. `ANTHROPIC_AUTH_TOKEN`
2. `CLAUDE_CODE_OAUTH_TOKEN`
3. `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`
4. `.credentials.json` under `CLAUDE_CONFIG_DIR` (default `~/.claude`)

Two forms are supported, and the difference between them matters:

- **`claude setup-token`** writes a long-lived token you put in
  `CLAUDE_CODE_OAUTH_TOKEN`. Self-contained; the sidecar needs no access to your
  `~/.claude`. The CLI treats this token as non-refreshable, so regenerate it
  when it expires.
- **Your existing login**, reused by pointing `CLAUDE_CONFIG_DIR` at a directory
  holding `.credentials.json`. That directory **must be writable**: the CLI
  rewrites the file when it refreshes OAuth. A read-only mount works until the
  access token ages out and then fails for a reason that looks nothing like a
  permissions problem.

Two variables are stripped from the child process on purpose:

- `ANTHROPIC_API_KEY` — shortcuts the whole order above and bills a Console
  account instead of the subscription this feature exists to use.
- `CLAUDECODE` — set inside a Claude Code session; a CLI that sees it refuses to
  nest, which would make the sidecar work from a plain terminal and fail from the
  one place a developer is most likely to start it.

`tools: []` removes the built-in toolset. This is the option that matters:
`allowedTools` only governs auto-approval, so setting that alone would leave
Read/Bash/Write visible and callable, and every headless denial would burn one of
the few `maxTurns` — failing with `error_max_turns` on exactly the complex boards
worth thinking about. With `LLM_OPPONENT_ALLOW_WEB_SEARCH` on, both options carry
`WebSearch` and `WebFetch` and nothing else.

`settingSources: []` keeps the subprocess from loading your personal
`CLAUDE.md`, settings, and skills. Those are written for whatever repo they sit
in and would arrive as instructions competing with the game's system prompt.

## Running it

```bash
cd sidecar
cp .env.example .env          # then fill in CLAUDE_CODE_OAUTH_TOKEN
pnpm install
pnpm start                    # listens on 127.0.0.1:8788
```

In another shell, start the client as usual (`pnpm dev` in `client/`, or Tilt).
The setup menu's AI opponent panel shows a **Claude opponent** toggle once the
sidecar answers its health probe; while the sidecar is down the toggle is
rendered disabled with the reason, rather than hidden.

There is also `sidecar/compose.yaml` for running it in a container. Note the
port binding is `127.0.0.1:8788` deliberately: the sidecar has no authentication
of its own, so publishing it on `0.0.0.0` hands anyone on the network a free
Claude endpoint billed to you.

## Configuration

Every variable is documented in `sidecar/.env.example`. The ones worth knowing:

| Variable | Default | What it changes |
|---|---|---|
| `LLM_OPPONENT_MODEL` | `claude-opus-5` | Which model plays |
| `LLM_OPPONENT_MAX_TURNS` | `4` | Agentic turns per decision; higher is slower and deeper |
| `LLM_OPPONENT_ALLOW_WEB_SEARCH` | `false` | Lets Claude look up cards and rulings before deciding |
| `LLM_OPPONENT_MAX_REQUEST_BYTES` | `1048576` | Board-state ceiling; an oversized state is rejected rather than truncated |

Client-side timeouts live in `client/src/constants/llmOpponent.ts`. The decision
budget is 120s — an order of magnitude above the WASM score-worker budget,
because this one covers a model that may think and search.

## Files

| Path | Role |
|---|---|
| `sidecar/src/claude/chooseAction.ts` | Session lifecycle, per-game lock, answer validation |
| `sidecar/src/claude/decisionContract.ts` | The request and decision schemas, including the JSON Schema the model is constrained to |
| `sidecar/src/claude/buildPrompt.ts` | System prompt and per-decision message |
| `sidecar/src/routes/v1/` | `choose-action`, `end-game`, `health` |
| `client/src/services/llmOpponentClient.ts` | Transport; no game logic |
| `client/src/adapter/wasm-adapter.ts` | `getLlmOpponentProposal`, the engine rebind |
| `client/src/hooks/useLlmOpponentHealth.ts` | One-shot probe that gates the toggle |

## Known limits

- A decision costs a model round-trip, so games are slower than against the
  built-in AI even with the cost gate.
- The full viewer state is sent each decision. The CLI compacts as a session
  grows, but a long Commander game will accumulate context.
- The sidecar has no authentication. Loopback only.
- Untested end-to-end against a live subscription. The unit tests stub the CLI;
  see the smoke check in `sidecar/README.md`.
