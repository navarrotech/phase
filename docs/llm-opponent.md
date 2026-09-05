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
     │                             │                    unseal credential        │
     │                             │                          ├── /v1/messages ─►│
     │                             │                          │◄── {"index": N} ─┤
     │◄── {index, reasoning} ──────┼──────────────────────────┤                  │
     ├── submitAiActionProposal ──►│                          │                  │
     │                             │ contract.permits → apply │                  │
```

Every failure edge falls back to `getAiActionProposal`. A missing credential, a
network error, a refusal, an unparseable answer, and an out-of-range index all
resolve to the built-in AI taking that one decision.

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

The credential is the **player's own** and is never stored in plaintext.

1. The browser posts it once to `POST /llm/credential`.
2. The Worker seals it with AES-256-GCM under the `LLM_SEAL_KEY` secret, using
   the authenticated Supabase user id as Additional Authenticated Data.
3. Only the sealed blob is returned, and only the sealed blob is written to
   `public.llm_credentials` (RLS-scoped to `auth.uid()`).
4. On each decision the Worker unseals in memory, calls Anthropic, and persists
   nothing.

The AAD binding means a blob lifted out of another account's row fails to open:
GCM authenticates the AAD, and the Worker only ever passes the id of the caller
it just verified. RLS already prevents that read; this makes the stolen bytes
worthless anyway.

Credentials live **outside** the `user_backups` envelope on purpose.
`buildBackup()` snapshots every user-owned localStorage key into cloud sync
*and* into the file the "export backup" button downloads. Anything reachable
from preferences ends up in a plaintext file the user may share.

Both Anthropic credential families work. The Worker classifies once at seal
time and stores the kind alongside the blob:

| Kind | Prefix | Auth |
|---|---|---|
| `api_key` | `sk-ant-` | `x-api-key: <key>` |
| `oauth_token` | `sk-ant-oat` | `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20` |

The `oauth_token` form is what `claude setup-token` prints. Note that it
authenticates as a Claude Code credential; billing and rate limits follow that
account, not a console API key's.

## Deploying

Worker secrets and vars (`lobby-worker/`):

```bash
# 32 random bytes, base64. Rotating it invalidates every stored credential —
# users re-enter theirs. There is deliberately no key-id envelope.
head -c 32 /dev/urandom | base64 | wrangler secret put LLM_SEAL_KEY

# Vars, both public values, in wrangler.toml or the dashboard:
#   SUPABASE_URL       https://<project>.supabase.co
#   SUPABASE_ANON_KEY  the publishable key
```

Database: run `supabase/schema.sql` — the `llm_credentials` section is
idempotent and additive.

Client: no build env is required. `VITE_LLM_API_URL` overrides the Worker base
URL for self-hosters; it otherwise follows `VITE_IMPORT_DECK_URL` and then the
official Worker.

Without Supabase the feature hides itself and the built-in AI is the opponent.

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
| Worker routes | `lobby-worker/src/llm-credential.ts`, `llm-decide.ts`, `llm-session.ts` |
| Schema | `supabase/schema.sql` |
| Client service | `client/src/services/llmOpponent/` |
| Seat routing | `client/src/game/controllers/aiController.ts` |
| UI | `client/src/components/settings/ReasoningOpponentSection.tsx`, `components/menu/AiOpponentConfig.tsx` |
