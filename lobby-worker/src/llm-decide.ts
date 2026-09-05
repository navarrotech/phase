// POST /llm/decide — ask a reasoning model to pick one action from the finite
// domain the engine issued.
//
// This route is deliberately narrow. It receives a decision brief the engine
// built, asks the model for an index into that brief's candidate list, and
// returns the index. It never constructs a game action, never interprets the
// rules, and never sees more of the game than the engine chose to put in the
// brief. If anything at all goes wrong — bad credential, upstream 5xx, an
// answer that is not a valid index — it says so and the client falls back to
// the built-in AI, so a failure costs a worse move rather than a stuck game.

import type { CredentialKind } from "./llm-credential";
import type { LlmEnv } from "./llm-session";

import { llmCorsHeaders, resolveUserId, unseal } from "./llm-session";

/**
 * Anthropic's model id. Pinned rather than floating: a silent model change
 * would alter both play strength and cost per game with no diff to point at.
 */
const MODEL = "claude-opus-5";

/** Wire version for the Messages API. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * `claude setup-token` credentials authenticate as OAuth bearers and require
 * this beta opt-in; console API keys use `x-api-key` and must not send it.
 */
const OAUTH_BETA = "oauth-2025-04-20";

/**
 * Generous enough for a full reasoning pass plus the answer object. The reply
 * itself is a handful of tokens; adaptive thinking is what consumes the budget.
 */
const MAX_TOKENS = 16000;

/**
 * Cap the brief we forward, in JSON characters. A pathological board (hundreds
 * of permanents, a storm count in the hundreds) would otherwise turn one
 * decision into a very expensive request; past this size the local AI is the
 * better answer.
 */
const MAX_BRIEF_CHARS = 256 * 1024;

/** Reasoning depth. `high` is the quality/latency knee for a bounded choice. */
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORT: Effort = "high";

type RequestBody = {
  sealed?: unknown;
  kind?: unknown;
  /** Static, cached prefix: the rules framing plus the seat's own decklist. */
  deckContext?: unknown;
  /** The engine's `DecisionBrief`, forwarded verbatim. */
  brief?: unknown;
};

type AnthropicContentBlock = {
  type?: string;
  text?: string;
};

type AnthropicResponse = {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: Record<string, unknown>;
  error?: { message?: string };
};

/**
 * The whole instruction set. It says exactly one thing, because the model has
 * exactly one job here: the engine has already decided what is legal.
 */
const SYSTEM_INSTRUCTIONS = [
  "You are playing a game of Magic: The Gathering through a rules engine.",
  "",
  "The engine has already computed every legal action for the decision in front",
  "of you and listed them as `candidates`, each with an `index`. Your entire task",
  "is to choose the index of the action you want to take. You cannot invent an",
  "action, and you do not need to check legality — anything in the list is legal,",
  "and anything not in the list is impossible.",
  "",
  "The board is given from your seat's point of view: `players[].isYou` marks you.",
  "Opponents' hands are hidden and appear only as a count, which is correct — play",
  "with that uncertainty rather than assuming the worst or the best.",
  "",
  "Object ids in an action payload refer to the `id` fields on the board lists, so",
  "resolve any id you care about by looking it up there.",
  "",
  "Think about it as carefully as the position deserves, then reply with ONLY a",
  'JSON object of the form {"index": <number>, "reasoning": "<one short sentence>"}.',
  "No prose outside the JSON, no code fences.",
].join("\n");

export async function handleLlmDecide(request: Request, env: LlmEnv): Promise<Response> {
  const cors = llmCorsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  }

  const userId = await resolveUserId(request, env);
  if (!userId) {
    return Response.json({ error: "Not signed in" }, { status: 401, headers: cors });
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  }
  catch {
    console.debug({ event: "llm_decide_bad_json" });
    return Response.json({ error: "Malformed request body" }, { status: 400, headers: cors });
  }

  if (typeof body.sealed !== "string" || (body.kind !== "api_key" && body.kind !== "oauth_token")) {
    console.debug({ event: "llm_decide_missing_credential" });
    return Response.json({ error: "Missing sealed credential" }, { status: 400, headers: cors });
  }
  const kind: CredentialKind = body.kind;

  const candidateCount = countCandidates(body.brief);
  if (candidateCount === null) {
    console.debug({ event: "llm_decide_malformed_brief" });
    return Response.json({ error: "Malformed decision brief" }, { status: 400, headers: cors });
  }

  const briefJson = JSON.stringify(body.brief);
  if (briefJson.length > MAX_BRIEF_CHARS) {
    console.warn({ event: "llm_decide_brief_too_large", chars: briefJson.length });
    return Response.json(
      { error: "Position too large to reason about", fallback: true },
      { status: 413, headers: cors },
    );
  }

  const credential = await unseal(env, userId, body.sealed);
  if (!credential) {
    // Covers a rotated sealing key and a blob from another account alike. The
    // user-facing fix is the same: re-enter the credential.
    console.debug({ event: "llm_decide_unseal_failed" });
    return Response.json(
      { error: "Stored credential could not be opened. Re-enter it in settings." },
      { status: 401, headers: cors },
    );
  }

  const deckContext = typeof body.deckContext === "string" ? body.deckContext : "";

  let upstream: Response;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: authHeaders(credential, kind),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // Adaptive thinking is the current contract on this model family;
        // `budget_tokens` is rejected outright. Depth is steered by effort.
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT },
        // Cache breakpoint placement is the whole reason the deck context is a
        // separate block: the instructions and the decklist are byte-identical
        // for every decision in a game, so they cache once and every later turn
        // reads them back. The volatile brief lives in the user message, after
        // the breakpoint, where it cannot invalidate the prefix.
        system: [
          { type: "text", text: SYSTEM_INSTRUCTIONS },
          {
            type: "text",
            text: deckContext,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: briefJson }],
      }),
    });
  }
  catch (error) {
    console.error({ event: "llm_decide_upstream_unreachable", error: String(error) });
    return Response.json(
      { error: "Could not reach the model", fallback: true },
      { status: 502, headers: cors },
    );
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    console.error({
      event: "llm_decide_upstream_error",
      upstreamStatus: upstream.status,
      // The body carries Anthropic's error message, never the credential.
      detail: detail.slice(0, 500),
    });
    return Response.json(
      {
        error: upstream.status === 401
          ? "The model provider rejected that credential."
          : `Model request failed (${upstream.status})`,
        fallback: true,
      },
      { status: upstream.status === 401 ? 401 : 502, headers: cors },
    );
  }

  const message = (await upstream.json()) as AnthropicResponse;

  // A safety decline arrives as HTTP 200 with this stop reason, so status alone
  // is not proof of an answer.
  if (message.stop_reason === "refusal") {
    console.warn({ event: "llm_decide_refused" });
    return Response.json(
      { error: "The model declined to answer", fallback: true },
      { status: 502, headers: cors },
    );
  }

  const text = (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

  const choice = parseChoice(text, candidateCount);
  if (!choice) {
    console.warn({ event: "llm_decide_unparseable", sample: text.slice(0, 200) });
    return Response.json(
      { error: "The model did not return a usable choice", fallback: true },
      { status: 502, headers: cors },
    );
  }

  console.log({
    event: "llm_decide_ok",
    index: choice.index,
    candidateCount,
    cacheRead: message.usage?.cache_read_input_tokens ?? 0,
  });

  return Response.json(choice, { status: 200, headers: cors });
}

function authHeaders(credential: string, kind: CredentialKind): Record<string, string> {
  const base = {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (kind === "oauth_token") {
    return {
      ...base,
      Authorization: `Bearer ${credential}`,
      "anthropic-beta": OAUTH_BETA,
    };
  }
  return { ...base, "x-api-key": credential };
}

/**
 * Number of candidates in the brief, or null when the brief is not the shape
 * the engine produces. Validating the count here is what lets this route reject
 * an out-of-range answer rather than handing the client an index that would be
 * refused at the action boundary anyway.
 */
function countCandidates(brief: unknown): number | null {
  if (!brief || typeof brief !== "object") return null;
  const candidates = (brief as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return candidates.length;
}

/**
 * Read the model's answer.
 *
 * Strict JSON first, since that is what the instructions ask for. The fallback
 * scans for the first `"index": N` pair, which recovers the case where a model
 * wraps its object in a code fence or a sentence — cheap insurance against a
 * whole turn being lost to formatting.
 */
function parseChoice(text: string, candidateCount: number): { index: number; reasoning: string } | null {
  const inRange = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value < candidateCount;

  try {
    const parsed = JSON.parse(text.trim()) as { index?: unknown; reasoning?: unknown };
    if (inRange(parsed.index)) {
      return {
        index: parsed.index,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      };
    }
  }
  catch {
    // Not bare JSON; fall through to the scan below.
  }

  const match = /"index"\s*:\s*(\d+)/.exec(text);
  if (!match) return null;
  const index = Number(match[1]);
  if (!inRange(index)) {
    console.debug({ event: "llm_decide_index_out_of_range", index, candidateCount });
    return null;
  }
  const reasoning = /"reasoning"\s*:\s*"([^"]*)"/.exec(text);
  return { index, reasoning: reasoning?.[1] ?? "" };
}
