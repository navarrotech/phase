import type { DecisionRequest } from './decisionContract'

/**
 * The persona and the rules of engagement, sent once per session as the system
 * prompt so it stays in the cached prefix across every decision in a game.
 *
 * It deliberately does NOT restate Magic's rules. The engine is the rules
 * authority and has already reduced the position to a finite legal-action list;
 * asking the model to re-derive legality invites it to argue with the engine and
 * pick an index for a line the engine never offered.
 */
export const SYSTEM_PROMPT = [
  'You are playing a game of Magic: The Gathering against a human opponent.',
  '',
  'You will be given the board state as JSON and a numbered list of every legal',
  'action available to you right now. The game engine produced both. The engine is',
  'the sole authority on the rules: if an action is not in the list, it is not',
  'legal, and there is nothing to appeal. Your only job is to choose the index of',
  'the strongest action in that list.',
  '',
  'The state is already scoped to what you are entitled to see. Zones you should',
  'not see are redacted. Do not speculate about hidden information as though you',
  'had it.',
  '',
  'Play to win, and play at a competitive level: count mana, respect the stack,',
  'track what the opponent can represent with untapped lands, and think a turn',
  'ahead about your own attacks and blocks. Passing priority is frequently the',
  'strongest action — holding up an instant beats jamming it at a bad time.',
  '',
  'Answer only with the structured decision. Keep the reasoning to one or two',
  'sentences; it is shown to your opponent in the game log.',
].join('\n')

/**
 * The per-decision message. The action list is numbered in the prompt so the
 * index the model reports and the index the client resolves are the same
 * quantity, stated once.
 */
export function buildDecisionPrompt(request: DecisionRequest): string {
  const numberedActions = request.actions
    .map((action, index) => `${index}: ${JSON.stringify(action)}`)
    .join('\n')

  return [
    `You are player ${request.playerId}. The engine is waiting on a ${request.waitingFor} decision.`,
    `Your configured difficulty for this seat is ${request.difficulty}.`,
    '',
    'Board state (engine JSON, scoped to you):',
    '```json',
    JSON.stringify(request.state),
    '```',
    '',
    `Legal actions (${request.actions.length}), one per line as "index: action":`,
    '```',
    numberedActions,
    '```',
    '',
    `Choose one index between 0 and ${request.actions.length - 1} inclusive.`,
  ].join('\n')
}
