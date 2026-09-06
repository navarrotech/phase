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
//
// Every caller brings their OWN Anthropic credential, so there is no account
// here and nothing to sign in to. The credential arrives over TLS, is used for
// one upstream call, and is never written down. Consequently this endpoint
// cannot leak one player's key to another — but it can be pointed at by anyone
// who finds the URL, which is a request-quota concern rather than a credential
// one. `ALLOWED_ORIGINS` and the per-IP bucket below are the answer to that.

/** Bindings this route reads. */
export interface LlmEnv {
  /** Comma-separated origin allowlist, or "*" (default) to allow any. */
  ALLOWED_ORIGINS?: string;
}

/**
 * Anthropic's model id. Pinned rather than floating: a silent model change
 * would alter both play strength and cost per game with no diff to point at.
 */
const MODEL = "claude-opus-5";

/** Wire version for the Messages API. */
const ANTHROPIC_VERSION = "2023-06-01";

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
  credential?: unknown;
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

  if (!isOriginAllowed(request, env)) {
    console.debug({ event: "llm_decide_origin_rejected", origin: request.headers.get("Origin") });
    return Response.json({ error: "Origin not allowed" }, { status: 403, headers: cors });
  }
  if (!withinRateLimit(request)) {
    console.warn({ event: "llm_decide_rate_limited", ip: clientAddress(request) });
    return Response.json(
      { error: "Too many requests", fallback: true },
      { status: 429, headers: cors },
    );
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  }
  catch {
    console.debug({ event: "llm_decide_bad_json" });
    return Response.json({ error: "Malformed request body" }, { status: 400, headers: cors });
  }

  if (typeof body.credential !== "string" || !body.credential.startsWith("sk-ant-")) {
    console.debug({ event: "llm_decide_missing_credential" });
    return Response.json({ error: "Missing credential" }, { status: 400, headers: cors });
  }
  // Anthropic authorizes `claude setup-token` credentials for Claude Code and
  // Claude.ai only, and refuses them here server-side. The client rejects them
  // at save time; this is the boundary's own check, so a stale stored token or
  // a hand-rolled request gets a legible answer instead of an opaque upstream
  // rate-limit error.
  if (body.credential.startsWith("sk-ant-oat")) {
    console.debug({ event: "llm_decide_subscription_token" });
    return Response.json(
      {
        error: "Claude subscription tokens cannot be used for API requests. "
          + "Use a console API key from console.anthropic.com.",
      },
      { status: 400, headers: cors },
    );
  }
  const credential: string = body.credential;

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

  const deckContext = typeof body.deckContext === "string" ? body.deckContext : "";

  let upstream: Response;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: authHeaders(credential),
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
      // First characters only — enough to identify the credential class, far
      // short of anything usable.
      credentialPrefix: credential.slice(0, 12),
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

/**
 * CORS headers, with the origin allowlist applied.
 *
 * Mirrors `turn.ts` so both HTTP routes answer preflights the same way.
 */
export function llmCorsHeaders(request: Request, env: LlmEnv): Record<string, string> {
  const allow = (env.ALLOWED_ORIGINS ?? "*").trim();
  let allowOrigin = "*";
  if (allow !== "*") {
    const origin = request.headers.get("Origin") ?? "";
    const list = allow.split(",").map((entry) => entry.trim()).filter(Boolean);
    allowOrigin = list.includes(origin) ? origin : (list[0] ?? "");
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

/**
 * Whether the caller's `Origin` is on the allowlist.
 *
 * A browser cannot forge `Origin`, so this genuinely stops another site from
 * driving this endpoint from a user's browser. It does NOT stop a direct
 * non-browser client, which can send any header it likes — that is what the
 * rate limit below is for. Default "*" keeps self-hosted deployments working
 * without configuration.
 */
export function isOriginAllowed(request: Request, env: LlmEnv): boolean {
  const allow = (env.ALLOWED_ORIGINS ?? "*").trim();
  if (allow === "*") return true;
  const origin = request.headers.get("Origin");
  // A same-origin or non-browser request may omit Origin entirely; the rate
  // limit still applies to it.
  if (!origin) return true;
  return allow.split(",").map((entry) => entry.trim()).includes(origin);
}

/** Requests one address may make per window before it is turned away. */
const RATE_LIMIT_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Per-address request budget.
 *
 * Deliberately modest in what it claims: the counters live in the isolate's
 * memory, so they reset when Cloudflare recycles it and are not shared between
 * the isolates a busy deployment runs. That makes this a speed bump against
 * casual abuse, not a quota. A deployment that needs a real limit should bind
 * Cloudflare's rate-limiting binding or route through the lobby Durable Object,
 * both of which hold state across isolates. Sized well above honest play, which
 * escalates a few dozen decisions per game with a model round-trip between them.
 */
const requestBudget = new Map<string, { count: number; resetAt: number }>();

export function withinRateLimit(
  request: Request,
  now: number = Date.now(),
): boolean {
  const address = clientAddress(request);
  const entry = requestBudget.get(address);

  if (!entry || now >= entry.resetAt) {
    requestBudget.set(address, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    // Drop windows that have already lapsed so a long-lived isolate does not
    // accumulate an entry per address it has ever seen.
    if (requestBudget.size > 1000) {
      for (const [key, value] of requestBudget) {
        if (now >= value.resetAt) requestBudget.delete(key);
      }
    }
    return true;
  }

  if (entry.count >= RATE_LIMIT_REQUESTS) return false;
  entry.count += 1;
  return true;
}

function clientAddress(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function authHeaders(credential: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "x-api-key": credential,
  };
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
