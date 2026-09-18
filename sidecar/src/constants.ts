/** Mount point for every versioned route. Mirrors the path the Vite dev proxy forwards. */
export const API_BASE_PATH = '/api/v1'

/**
 * Body-size ceiling for the Express JSON parser. Deliberately larger than
 * `LLM_OPPONENT_MAX_REQUEST_BYTES`: the request must parse before the route can
 * reject an oversized board with an explanation, and a parser-level rejection
 * surfaces as an opaque 413 instead.
 */
export const JSON_BODY_LIMIT = '32mb'

/**
 * Upper bound on actions offered to Claude in one decision. A priority window
 * with more branches than this is almost always a mana-payment permutation
 * explosion, which the engine's own shortcut handles better than prose can.
 */
export const MAX_OFFERED_ACTIONS = 150
