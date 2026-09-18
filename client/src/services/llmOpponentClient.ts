import type { GameAction, GameState } from "../adapter/types";

import {
  LLM_OPPONENT_CHOOSE_ACTION_URL,
  LLM_OPPONENT_DECISION_TIMEOUT_MS,
  LLM_OPPONENT_END_GAME_URL,
  LLM_OPPONENT_HEALTH_TIMEOUT_MS,
  LLM_OPPONENT_HEALTH_URL,
} from "../constants/llmOpponent";

/**
 * Transport for the local LLM opponent sidecar (`sidecar/`).
 *
 * This module is a serialization boundary and nothing else. It forwards the
 * engine's own viewer-scoped state and legal-action list untouched, and returns
 * an index into that same list. It never builds, filters, scores, or interprets
 * a `GameAction` — the engine authored the list and the engine re-validates the
 * choice against a freshly issued decision contract before it can be submitted.
 */

export interface LlmOpponentDecision {
  actionIndex: number;
  reasoning: string;
  sessionId: string;
  durationMs: number;
}

export interface LlmOpponentHealth {
  status: string;
  credential: "setup-token" | "config-dir" | "ambient";
  model: string;
  webSearch: boolean;
  activeSeats: number;
}

export interface LlmOpponentDecisionRequest {
  gameId: string;
  playerId: number;
  difficulty: string;
  waitingFor: string;
  state: GameState;
  actions: GameAction[];
}

/** Thrown for every sidecar failure, so one catch at the call site covers them all. */
export class LlmOpponentUnavailableError extends Error {}

export async function requestLlmOpponentDecision(
  request: LlmOpponentDecisionRequest,
): Promise<LlmOpponentDecision> {
  const response = await postJson(
    LLM_OPPONENT_CHOOSE_ACTION_URL,
    request,
    LLM_OPPONENT_DECISION_TIMEOUT_MS,
  );

  const decision = (await response.json()) as LlmOpponentDecision;

  // The sidecar already range-checks the index, but it is a separate process
  // that can be upgraded independently of this client. An index that would
  // read past the end of the list must not become an `undefined` action.
  if (
    !Number.isInteger(decision.actionIndex) ||
    decision.actionIndex < 0 ||
    decision.actionIndex >= request.actions.length
  ) {
    throw new LlmOpponentUnavailableError(
      `Sidecar returned action index ${decision.actionIndex} for ${request.actions.length} actions`,
    );
  }

  return decision;
}

/**
 * Releases a finished game's Claude session. Best-effort by design: this runs on
 * teardown paths where nothing can be retried and no user-visible failure is
 * appropriate — a leaked session costs the sidecar one map entry.
 */
export async function releaseLlmOpponentGame(gameId: string): Promise<void> {
  try {
    await postJson(LLM_OPPONENT_END_GAME_URL, { gameId }, LLM_OPPONENT_HEALTH_TIMEOUT_MS);
  } catch (error) {
    console.debug("LLM opponent sidecar did not release the game session", error);
  }
}

/** Probes the sidecar. Returns null when it is not running or not answering. */
export async function probeLlmOpponent(): Promise<LlmOpponentHealth | null> {
  try {
    const response = await fetch(LLM_OPPONENT_HEALTH_URL, {
      signal: AbortSignal.timeout(LLM_OPPONENT_HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.debug(`LLM opponent sidecar health returned ${response.status}`);
      return null;
    }
    return (await response.json()) as LlmOpponentHealth;
  } catch (error) {
    console.debug("LLM opponent sidecar is not reachable", error);
    return null;
  }
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<Response> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // A timeout surfaces as an AbortError, which reads as a cancellation rather
    // than a failure unless it is renamed here.
    const reason = error instanceof Error && error.name === "TimeoutError"
      ? `timed out after ${timeoutMs}ms`
      : String(error);
    throw new LlmOpponentUnavailableError(`LLM opponent sidecar ${reason}`);
  }

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new LlmOpponentUnavailableError(`LLM opponent sidecar returned ${response.status}: ${message}`);
  }

  return response;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
