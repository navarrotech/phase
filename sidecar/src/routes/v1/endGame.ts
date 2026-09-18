import type { Request, Response } from 'express'

// Core
import { z } from 'zod'

// Misc
import { forgetGame } from '../../claude/chooseAction'

const endGameSchema = z.object({
  gameId: z.string().min(1),
})

/**
 * POST /api/v1/end-game
 *
 * Drops a finished game's Claude session so the next game starts a fresh
 * conversation instead of inheriting the last one's plans. Idempotent: ending a
 * game the sidecar never saw is a success, because the client sends this on
 * teardown paths that may fire without a decision ever having been requested.
 */
export function postEndGame(request: Request, response: Response): void {
  const validation = endGameSchema.safeParse(request.body)
  if (!validation.success) {
    console.debug('end-game rejected a malformed body', validation.error.flatten().fieldErrors)
    response.status(400).json({ message: 'Invalid end-game request' })
    return
  }

  forgetGame(validation.data.gameId)
  response.status(200).json({ message: 'Session released' })
}
