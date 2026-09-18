import { z } from 'zod'

/**
 * The request the game client sends for one decision.
 *
 * `actions` is the engine's own viewer-scoped legal-action list, forwarded
 * verbatim. `state` is the engine's viewer-scoped (hidden zones already
 * redacted) game state, also verbatim — the client is a display layer and does
 * not get to decide what the opponent is allowed to reason about, and a
 * redaction implemented here would be a second, drifting copy of the engine's.
 */
export const decisionRequestSchema = z.object({
  /** Stable per-game id. Keys the resumable Claude session, so one game is one conversation. */
  gameId: z.string().min(1),
  /** Engine `PlayerId` of the seat Claude is playing. */
  playerId: z.number().int().nonnegative(),
  /** Engine difficulty label for the seat, passed through for flavor only. */
  difficulty: z.string().min(1),
  /** Engine `WaitingFor` discriminant, e.g. "Priority" or "MulliganDecision". */
  waitingFor: z.string().min(1),
  state: z.unknown(),
  actions: z.array(z.unknown()).min(1),
})

export type DecisionRequest = z.infer<typeof decisionRequestSchema>

/**
 * What Claude must answer with.
 *
 * An INDEX, never a reconstructed action. This is the whole safety model: the
 * model picks from a list the engine authored, so the worst decision it can
 * reach is a legal-but-bad one. It cannot invent an action, target something it
 * shouldn't see, or hand the client a payload the engine would have to validate.
 */
export const decisionSchema = z.object({
  actionIndex: z.number().int().nonnegative(),
  reasoning: z.string(),
})

export type Decision = z.infer<typeof decisionSchema>

/**
 * The same contract as a JSON Schema, for the Agent SDK's `outputFormat`. The
 * SDK constrains the model to this shape and retries on its own when the model
 * strays, which is why the schema is declared rather than coaxed for in prose.
 */
export const DECISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    actionIndex: {
      type: 'integer',
      minimum: 0,
      description: 'Zero-based index into the numbered action list you were given.',
    },
    reasoning: {
      type: 'string',
      description: 'One or two sentences on why this line is best. Shown in the game log.',
    },
  },
  required: ['actionIndex', 'reasoning'],
  additionalProperties: false,
} as const satisfies Record<string, unknown>

/** What the client receives back. `sessionId` is echoed for log correlation only. */
export type DecisionResponse = Decision & {
  sessionId: string
  durationMs: number
}
