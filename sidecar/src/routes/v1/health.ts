import type { Request, Response } from 'express'

// Misc
import { activeSeatCount } from '../../claude/chooseAction'
import { environment } from '../../env'

/**
 * GET /api/v1/health
 *
 * Reports which credential form is configured, never the credential. The client
 * probes this once before offering the LLM opponent, so a missing token shows
 * up as a disabled toggle with a reason rather than a failed first decision
 * three turns into a game.
 */
export function getHealth(_request: Request, response: Response): void {
  const credential = environment.CLAUDE_CODE_OAUTH_TOKEN
    ? 'setup-token'
    : environment.CLAUDE_CONFIG_DIR
      ? 'config-dir'
      : 'ambient'

  response.status(200).json({
    status: 'ok',
    credential,
    model: environment.LLM_OPPONENT_MODEL,
    webSearch: environment.LLM_OPPONENT_ALLOW_WEB_SEARCH,
    activeSeats: activeSeatCount(),
  })
}
