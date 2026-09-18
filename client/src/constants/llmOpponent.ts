// Same-origin paths. The Vite dev server proxies `/llm-opponent` to the local
// sidecar (see vite.config.ts), so the browser never issues a cross-origin
// request and there is no CORS surface to configure.
export const LLM_OPPONENT_CHOOSE_ACTION_URL = "/llm-opponent/api/v1/choose-action";
export const LLM_OPPONENT_END_GAME_URL = "/llm-opponent/api/v1/end-game";
export const LLM_OPPONENT_HEALTH_URL = "/llm-opponent/api/v1/health";

/**
 * How long one decision may take before the client gives up and lets the
 * built-in AI move instead.
 *
 * An order of magnitude above `AI_POOL_SCORE_TIMEOUT_MS` on purpose: that
 * budget covers a WASM search, this one covers a model that may think, search
 * the web, and take several agentic turns. The stale-state watchdog arms at
 * 10s but only re-commits the adapter's own snapshot, so a decision outliving
 * it costs a redundant commit, not a stuck board.
 */
export const LLM_OPPONENT_DECISION_TIMEOUT_MS = 120_000;

/** Probe budget for the health check that gates the toggle. */
export const LLM_OPPONENT_HEALTH_TIMEOUT_MS = 3_000;

/**
 * Below this many legal actions there is nothing to decide, so the request is
 * skipped and the engine's own AI answers instantly. A priority window offering
 * only "pass" is the overwhelmingly common case in Magic — consulting a model
 * for each one would make a turn take minutes and burn a subscription on
 * foregone conclusions.
 */
export const LLM_OPPONENT_MIN_ACTIONS = 2;
