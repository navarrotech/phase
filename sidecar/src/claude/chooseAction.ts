import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { DecisionRequest, DecisionResponse } from './decisionContract'

// Core
import { query } from '@anthropic-ai/claude-agent-sdk'

// Misc
import { buildChildEnvironment, environment } from '../env'
import { buildDecisionPrompt, SYSTEM_PROMPT } from './buildPrompt'
import { DECISION_JSON_SCHEMA, decisionSchema } from './decisionContract'

/** Raised when Claude answered but the answer cannot be trusted as a move. */
export class DecisionRejectedError extends Error {}

/**
 * One Claude session per game, and one decision at a time within it.
 *
 * Both halves matter. The session id is what makes this a conversation rather
 * than a sequence of strangers — Claude remembers the plan it committed to two
 * turns ago. The lock is what keeps that conversation coherent: a resumable
 * session has a single linear transcript, so two decisions resumed from the
 * same id concurrently race to append to it.
 */
type GameSession = {
  sessionId: string | null
  queue: Promise<unknown>
}

const sessionsByGameId = new Map<string, GameSession>()

/** Drops a game's session so the next decision starts a fresh conversation. */
export function forgetGame(gameId: string): void {
  sessionsByGameId.delete(gameId)
}

export function activeGameCount(): number {
  return sessionsByGameId.size
}

export async function chooseAction(request: DecisionRequest): Promise<DecisionResponse> {
  const session = sessionsByGameId.get(request.gameId) ?? { sessionId: null, queue: Promise.resolve() }
  sessionsByGameId.set(request.gameId, session)

  // Chain onto the queue before awaiting it, so concurrent callers line up
  // behind each other rather than all observing the same settled promise.
  const decision = session.queue.then(
    () => runDecision(request, session),
    () => runDecision(request, session),
  )
  session.queue = decision.catch(() => undefined)

  return decision
}

async function runDecision(request: DecisionRequest, session: GameSession): Promise<DecisionResponse> {
  const startedAt = Date.now()

  const options: Options = {
    model: environment.LLM_OPPONENT_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: environment.LLM_OPPONENT_MAX_TURNS,
    outputFormat: { type: 'json_schema', schema: DECISION_JSON_SCHEMA },
    env: buildChildEnvironment(),
    // The sidecar is not a coding agent. Web search is the only tool that can
    // improve a play decision (looking up an unfamiliar card or ruling); file
    // and shell tools can only cost latency and reach outside the game.
    allowedTools: environment.LLM_OPPONENT_ALLOW_WEB_SEARCH ? ['WebSearch', 'WebFetch'] : [],
    // Without this the subprocess inherits the operator's own CLAUDE.md,
    // settings and skills. Those are written for whatever repo they sit in and
    // would arrive as instructions competing with the system prompt above.
    settingSources: [],
    ...(session.sessionId ? { resume: session.sessionId } : {}),
  }

  let result: Extract<SDKMessage, { type: 'result' }> | null = null

  for await (const message of query({ prompt: buildDecisionPrompt(request), options })) {
    if (message.type === 'result') {
      result = message
    }
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
