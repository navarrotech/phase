import type { Request, Response } from 'express'

// Core
import { chooseAction, DecisionRejectedError } from '../../claude/chooseAction'
import { decisionRequestSchema } from '../../claude/decisionContract'

// Misc
import { MAX_OFFERED_ACTIONS } from '../../constants'
import { environment } from '../../env'

/**
 * POST /api/v1/choose-action
 *
 * Every failure here is a 4xx/5xx with a reason, never a fabricated move: the
 * caller treats any non-200 as "the LLM opponent is unavailable for this
 * decision" and falls back to the engine's built-in AI, so the game continues
 * either way and the reason reaches the log rather than the board.
 */
export async function postChooseAction(request: Request, response: Response): Promise<void> {
  const validation = decisionRequestSchema.safeParse(request.body)
  if (!validation.success) {
    console.debug('choose-action rejected a malformed body', validation.error.flatten().fieldErrors)
    response.status(400).json({
      message: 'Invalid decision request',
      issues: validation.error.flatten().fieldErrors,
    })
    return
  }

  const decisionRequest = validation.data

  if (decisionRequest.actions.length > MAX_OFFERED_ACTIONS) {
    console.debug(
      `choose-action declined ${decisionRequest.actions.length} actions for game ${decisionRequest.gameId}`,
    )
    response.status(422).json({
      message: `Too many legal actions to decide on (${decisionRequest.actions.length} > ${MAX_OFFERED_ACTIONS})`,
    })
    return
  }

  // Measured on the parsed body rather than Content-Length so a compressed
  // request is judged by what Claude will actually read.
  const stateBytes = Buffer.byteLength(JSON.stringify(decisionRequest.state ?? null))
  if (stateBytes > environment.LLM_OPPONENT_MAX_REQUEST_BYTES) {
    console.debug(`choose-action declined a ${stateBytes}-byte state for game ${decisionRequest.gameId}`)
    response.status(413).json({
      message: `Game state is ${stateBytes} bytes, over the ${environment.LLM_OPPONENT_MAX_REQUEST_BYTES}-byte limit`,
    })
    return
  }

  try {
    const decision = await chooseAction(decisionRequest)
    console.debug(
      `choose-action: game ${decisionRequest.gameId} player ${decisionRequest.playerId} `
        + `chose ${decision.actionIndex}/${decisionRequest.actions.length} in ${decision.durationMs}ms`,
    )
    response.status(200).json(decision)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A rejected decision is Claude answering badly; anything else is the
    // sidecar or the CLI failing. Both end the same way for the caller, but
    // only one of them is worth reading a stack trace for.
    if (error instanceof DecisionRejectedError) {
      console.warn(`choose-action could not use Claude's answer: ${message}`)
      response.status(422).json({ message })
      return
    }

    console.error('choose-action failed', error)
    response.status(502).json({ message })
  }
}
