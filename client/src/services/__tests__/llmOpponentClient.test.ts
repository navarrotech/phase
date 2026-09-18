import type { GameAction, GameState } from "../../adapter/types";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LlmOpponentUnavailableError,
  probeLlmOpponent,
  releaseLlmOpponentGame,
  requestLlmOpponentDecision,
} from "../llmOpponentClient";

const ACTIONS = [
  { type: "PassPriority" },
  { type: "PlayLand", data: { object_id: 7 } },
] as unknown as GameAction[];

function buildRequest() {
  return {
    gameId: "game-1",
    playerId: 1,
    difficulty: "VeryHard",
    waitingFor: "Priority",
    state: { turn_number: 3 } as unknown as GameState,
    actions: ACTIONS,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("requestLlmOpponentDecision", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the decision the sidecar sent", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ actionIndex: 1, reasoning: "Land first.", sessionId: "s1", durationMs: 12 }),
    );

    const decision = await requestLlmOpponentDecision(buildRequest());

    expect(decision.actionIndex).toBe(1);
    expect(decision.reasoning).toBe("Land first.");
  });

  it("posts the engine's state and actions untouched", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ actionIndex: 0, reasoning: "Pass.", sessionId: "s1", durationMs: 9 }),
    );

    await requestLlmOpponentDecision(buildRequest());

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.state).toEqual({ turn_number: 3 });
    expect(body.actions).toEqual(ACTIONS);
  });

  // The sidecar range-checks too, but it is a separate process that can be
  // upgraded independently. An index past the end must never reach the adapter
  // and become an `undefined` action.
  it.each([
    ["past the end", 2],
    ["negative", -1],
    ["not an integer", 1.5],
  ])("rejects an index that is %s", async (_label, actionIndex) => {
    fetchMock.mockResolvedValue(
      jsonResponse({ actionIndex, reasoning: "bad", sessionId: "s1", durationMs: 4 }),
    );

    await expect(requestLlmOpponentDecision(buildRequest())).rejects.toBeInstanceOf(
      LlmOpponentUnavailableError,
    );
  });

  it("surfaces the sidecar's own error message on a non-200", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: "Too many legal actions" }, { status: 422 }),
    );

    await expect(requestLlmOpponentDecision(buildRequest())).rejects.toThrow(
      /422: Too many legal actions/,
    );
  });

  it("reports a timeout as a timeout rather than a cancellation", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);

    await expect(requestLlmOpponentDecision(buildRequest())).rejects.toThrow(/timed out after/);
  });

  it("treats a connection refusal as unavailable, not as a crash", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(requestLlmOpponentDecision(buildRequest())).rejects.toBeInstanceOf(
      LlmOpponentUnavailableError,
    );
  });
});

describe("probeLlmOpponent", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the health payload when the sidecar answers", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: "ok",
        credential: "setup-token",
        model: "claude-opus-5",
        webSearch: false,
        activeGames: 0,
      }),
    );

    await expect(probeLlmOpponent()).resolves.toMatchObject({ model: "claude-opus-5" });
  });

  it("returns null rather than throwing when the sidecar is down", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(probeLlmOpponent()).resolves.toBeNull();
  });

  it("returns null on a non-200 health response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 503 }));

    await expect(probeLlmOpponent()).resolves.toBeNull();
  });
});

describe("releaseLlmOpponentGame", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Called from teardown paths where nothing can be retried and no user-visible
  // failure is appropriate. A leaked session costs the sidecar one map entry.
  it("never rejects when the sidecar is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(releaseLlmOpponentGame("game-1")).resolves.toBeUndefined();
  });
});
