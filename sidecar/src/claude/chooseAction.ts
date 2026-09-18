import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { DecisionRequest, DecisionResponse } from './decisionContract'

// Core
import { query } from '@anthropic-ai/claude-agent-sdk'

// Misc
import { DECISION_TIMEOUT_MS } from '../constants'
import { buildChildEnvironment, environment } from '../env'
import { buildDecisionPrompt, SYSTEM_PROMPT } from './buildPrompt'
import { DECISION_JSON_SCHEMA, decisionSchema } from './decisionContract'

/** Raised when Claude answered but the answer cannot be trusted as a move. */
export class DecisionRejectedError extends Error {}

/**
 * One Claude session per SEAT, and one decision at a time within it.
 *
 * Both halves matter. The session id is what makes this a conversation rather
 * than a sequence of strangers — Claude remembers the plan it committed to two
 * turns ago. The lock is what keeps that conversation coherent: a resumable
 * session has a single linear transcript, so two decisions resumed from the
 * same id concurrently race to append to it.
 *
 * Keyed per seat rather than per game because a multiplayer table runs several
 * AI seats at once. Sharing one transcript across them would leave seat 2
 * reading seat 1's redacted-but-visible hand out of the conversation history —
 * the engine's per-viewer redaction, undone by the memory that sits above it.
 */
type SeatSession = {
  sessionId: string | null
  queue: Promise<unknown>
}

const sessionsBySeatKey = new Map<string, SeatSession>()

function seatKey(gameId: string, playerId: number): string {
  return `${gameId}:${playerId}`
}

/** Drops every seat's session for a game, so the next one starts fresh. */
export function forgetGame(gameId: string): void {
  const prefix = `${gameId}:`
  for (const key of sessionsBySeatKey.keys()) {
    if (key.startsWith(prefix)) {
      sessionsBySeatKey.delete(key)
    }
  }
}

export function activeSeatCount(): number {
  return sessionsBySeatKey.size
}

export async function chooseAction(request: DecisionRequest): Promise<DecisionResponse> {
  const key = seatKey(request.gameId, request.playerId)
  const session = sessionsBySeatKey.get(key) ?? { sessionId: null, queue: Promise.resolve() }
  sessionsBySeatKey.set(key, session)

  // Chain onto the queue before awaiting it, so concurrent callers line up
  // behind each other rather than all observing the same settled promise.
  const decision = session.queue.then(
    () => runDecision(request, session),
    () => runDecision(request, session),
  )
  session.queue = decision.catch(() => undefined)

  return decision
}

async function runDecision(request: DecisionRequest, session: SeatSession): Promise<DecisionResponse> {
  const startedAt = Date.now()
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(), DECISION_TIMEOUT_MS)

  const options: Options = {
    model: environment.LLM_OPPONENT_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: environment.LLM_OPPONENT_MAX_TURNS,
    outputFormat: { type: 'json_schema', schema: DECISION_JSON_SCHEMA },
    env: buildChildEnvironment(),
    abortController,
    // The sidecar is not a coding agent. `tools` is what actually removes the
    // built-in toolset; `allowedTools` only governs auto-approval, so setting
    // that alone would leave Read/Bash/Write visible and callable, and every
    // headless denial would burn one of the few turns below — failing with
    // `error_max_turns` on exactly the complex boards worth thinking about.
    // Web search is the only tool that can improve a play decision.
    tools: environment.LLM_OPPONENT_ALLOW_WEB_SEARCH ? ['WebSearch', 'WebFetch'] : [],
    allowedTools: environment.LLM_OPPONENT_ALLOW_WEB_SEARCH ? ['WebSearch', 'WebFetch'] : [],
    // Without this the subprocess inherits the operator's own CLAUDE.md,
    // settings and skills. Those are written for whatever repo they sit in and
    // would arrive as instructions competing with the system prompt above.
    settingSources: [],
    ...(session.sessionId ? { resume: session.sessionId } : {}),
  }

  let result: Extract<SDKMessage, { type: 'result' }> | null = null

  try {
    for await (const message of query({ prompt: buildDecisionPrompt(request), options })) {
      if (message.type === 'result') {
        result = message
      }
    }
  }
  finally {
    clearTimeout(timeoutId)
  }

  if (abortController.signal.aborted) {
    throw new DecisionRejectedError(`Claude did not answer within ${DECISION_TIMEOUT_MS}ms`)
  }

  if (!result) {
    throw new DecisionRejectedError('Claude session ended without producing a result message')
  }

  // Resume only from a session that actually completed a turn. Latching the id
  // of a failed turn would make every later decision resume a broken transcript.
  if (result.subtype === 'success') {
    session.sessionId = result.session_id
  }

  if (result.subtype !== 'success') {
    throw new DecisionRejectedError(`Claude ended the turn early (${result.subtype}): ${result.errors.join('; ')}`)
  }

  if (result.is_error) {
    throw new DecisionRejectedError(`Claude reported an API error: ${result.result}`)
  }

  const parsed = decisionSchema.safeParse(result.structured_output)
  if (!parsed.success) {
    throw new DecisionRejectedError(
      `Claude's answer did not match the decision schema: ${parsed.error.message}`,
    )
  }

  // The schema guarantees a non-negative integer, not one that indexes THIS
  // list. An out-of-range index is the one failure that would otherwise become
  // an `undefined` action and a confusing error at the engine boundary.
  if (parsed.data.actionIndex >= request.actions.length) {
    throw new DecisionRejectedError(
      `Claude chose action ${parsed.data.actionIndex} but only ${request.actions.length} were offered`,
    )
  }

  return {
    ...parsed.data,
    sessionId: result.session_id,
    durationMs: Date.now() - startedAt,
  }
}
