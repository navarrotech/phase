# Reasoning Opponent

A player can hand any AI seat to a Claude model instead of the built-in AI. The
model chooses moves; the engine still owns every rule.

## What the model is and is not

It is a **chooser**. For each decision the engine issues a finite list of legal
actions and the model returns one index. It cannot name an action outside that
list, so it cannot cheat, cannot make an illegal play, and cannot desync the
game. A wrong answer is a bad move, never an invalid one.

It is **not** a difficulty level. A reasoner seat still carries an
`AiDifficulty`, because the engine declines to escalate most decisions and its
own chooser answers those.

## Flow

```
aiController                 engine (WASM)              lobby Worker         Anthropic
     │                             │                          │                  │
     ├── getLlmDecisionBrief ─────►│                          │                  │
     │                             │ AiDecisionContract::issue│                  │
     │                             │ prepare_llm_decision     │                  │
     │◄─ defer{reason} ────────────┤   ← most decisions       │                  │
     │      └─► getAiActionProposal (built-in AI)             │                  │
     │                             │                          │                  │
     │◄─ consult{token, brief} ────┤                          │                  │
     ├── POST /llm/decide ─────────┼─────────────────────────►│                  │
     │      (credential + brief)   │                          ├── /v1/messages ─►│
     │                             │                          │◄── {"index": N} ─┤
     │◄── {index, reasoning} ──────┼──────────────────────────┤                  │
     ├── submitAiActionProposal ──►│                          │                  │
     │                             │ contract.permits → apply │                  │
```

Every failure edge falls back to `getAiActionProposal`. A missing credential, a
network error, a refusal, an unparseable answer, a rate-limit rejection, and an
out-of-range index all resolve to the built-in AI taking that one decision.

## Escalation

`prepare_llm_decision` (`crates/engine/src/ai_support/llm_brief.rs`) decides
what reaches the model. It defers on:

| Reason | Meaning |
|---|---|
| `noCandidates` | Contract issued nothing — combat declarations are validator-bounded, not enumerated. |
| `singleCandidate` | One legal action. Nothing to choose. |
| `mechanicalPriority` | A priority prompt with no action that changes the game beyond passing or making mana, per `has_meaningful_priority_action` — the same authority the human auto-pass gate uses. |
| `mechanicalPayment` | Mana payment and source selection. The engine's solver is already good at these and they dominate the decision count. |

This is what makes the feature affordable. A game contains hundreds to low
thousands of prompts; escalation cuts that to the few dozen that are real
decisions.

## What the model sees

`DecisionBrief` is a purpose-built projection, not `ClientGameStateRef` — that
view serializes the whole `GameState` for a renderer that already knows the
rules, and is far larger than a chooser needs.

- Board state for every player: life, poison, library and hand counts,
  battlefield, graveyard, mana pool.
- **Its own hand only.** Opponents contribute a count. CR 400.2 / CR 401.4.
- Face-down permanents render as "Face-down creature" (CR 708.2), never the
  printed name.
- The stack, combat, the pending prompt, and the numbered candidate list.

Once per game it also receives its full decklist with the engine's own parse of
each card, including the per-clause `supported` flag — so it learns what this
engine actually implements and stops planning around clauses the parser dropped.
That block is the cached prefix; the per-decision brief goes after the cache
breakpoint so it cannot invalidate it.

Object ids in an action payload resolve against the board lists. No heuristic
walks the payload guessing which integers are ids.

## Credential handling

The credential is the **player's own** and lives on their device. There is no
account, no sign-in, and no server-side copy.

1. The player pastes a key into Settings → Data → Reasoning Opponent.
2. It is validated and written to IndexedDB (`phase-llm-credential`) via
   `idb-keyval`.
3. Each escalated decision sends it to `POST /llm/decide` over TLS. The Worker
   uses it for one upstream call and persists nothing.

IndexedDB rather than localStorage is deliberate. `buildBackup()` snapshots
every user-owned localStorage key into cloud sync *and* into the file the
"export backup" button downloads, so anything stored there ends up in a
plaintext JSON file the player may share. IndexedDB is explicitly outside that
envelope — see the header of `client/src/services/backup.ts`.

The tradeoff, stated in the settings copy: the key does not follow the player to
another device, and clearing site data removes it.

**Console API keys only** (`sk-ant-api03-…`), sent as `x-api-key`.

A `claude setup-token` credential (`sk-ant-oat…`) does **not** work and is
rejected by name at save time. Anthropic authorizes subscription OAuth
credentials for Claude Code and Claude.ai only and refuses them on
`/v1/messages`; the observed failure is a persistent `rate_limit_error` with no
`retry-after` and no `anthropic-ratelimit-*` headers, not a clean 401, so
accepting one would produce an opponent that silently never plays. Rejecting it
in the settings field with an explanation is the whole of the handling.

Verified empirically against the live API: a fake `sk-ant-oat01-` token returns
`401 OAuth access token is invalid`, while a real one returns `429
rate_limit_error` unchanged across six attempts spaced 30s apart.

### What the Worker does and does not protect

Every caller brings their own credential, so this endpoint cannot leak one
player's key to another — there is nothing of one player's stored for another to
reach. What it *can* do is serve anyone who finds the URL, which costs request
quota rather than credentials.

Two guards bound that, and neither is oversold:

- **`ALLOWED_ORIGINS`** — a browser cannot forge `Origin`, so an allowlist
  genuinely stops another site driving the endpoint from a user's browser. It
  does nothing against a non-browser client. Default `"*"`; set it to the
  deployment's own origin in production.
- **Per-address rate limit** — 30 requests per minute, counted in the isolate's
  memory. That resets when Cloudflare recycles the isolate and is not shared
  between isolates, so it is a speed bump, not a quota. A deployment needing a
  real limit should bind Cloudflare's rate-limiting binding or route through the
  lobby Durable Object. The budget sits well above honest play, which escalates
  a few dozen decisions per game with a model round-trip between each.

## Deploying

Nothing to provision. The route needs no secret, no binding, and no database —
`supabase/schema.sql` is untouched by this feature.

The one setting worth changing in `lobby-worker/wrangler.toml`:

```toml
ALLOWED_ORIGINS = "https://phase-rs.dev"   # rather than the default "*"
```

Client: no build env required. `VITE_LLM_API_URL` overrides the Worker base URL
for self-hosters; it otherwise follows `VITE_IMPORT_DECK_URL` and then the
official Worker.

## Cost and pacing

Requests bill to the player's own Anthropic account. Model is pinned to
`claude-opus-5` with adaptive thinking at `high` effort, so a decision takes
seconds rather than milliseconds. The per-decision timeout is 180s, and the
static deck block is prompt-cached across the whole game.

## Where the code lives

| Layer | Path |
|---|---|
| Escalation + brief | `crates/engine/src/ai_support/llm_brief.rs` |
| WASM exports | `get_llm_decision_brief`, `get_deck_card_names` in `crates/engine-wasm/src/lib.rs` |
| Worker route | `lobby-worker/src/llm-decide.ts` |
| Client service | `client/src/services/llmOpponent/` |
| Seat routing | `client/src/game/controllers/aiController.ts` |
| UI | `client/src/components/settings/ReasoningOpponentSection.tsx`, `components/menu/AiOpponentConfig.tsx` |
