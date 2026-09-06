// POST /llm/verify — does this credential actually work?
//
// The settings screen runs this once, when the player saves a key, so a bad
// credential is caught while they are looking at the field rather than three
// turns into a game. That gap is the reason this route exists: a rejected
// credential makes the reasoning seat fall back to the built-in AI on every
// decision, which looks like a fast opponent rather than a broken one.
//
// It is the smallest real request that proves the whole path: same endpoint,
// same auth header, same model the game will use. A 200 here means a decision
// will authenticate too.

import type { LlmEnv } from "./llm-http";

import {
  ANTHROPIC_VERSION,
  authHeaders,
  checkCredential,
  clientAddress,
  isOriginAllowed,
  llmCorsHeaders,
  SUBSCRIPTION_TOKEN_MESSAGE,
  withinRateLimit,
} from "./llm-http";

/** Must match the model `llm-decide.ts` plays with, or this proves nothing. */
const MODEL = "claude-opus-5";

/**
 * Room for a short reply plus whatever reasoning the model does on the way.
 * Adaptive thinking is on by default for this model family, so a ceiling as
 * tight as the answer would truncate rather than fail — and a truncated 200 is
 * still a 200, which is all this route reads.
 */
const MAX_TOKENS = 64;

/** The cheapest possible prompt. This is an auth check, not a capability test. */
const PROBE_PROMPT = "Reply with the single word: ok";

type RequestBody = {
  credential?: unknown;
};

type AnthropicResponse = {
  model?: string;
  error?: { message?: string };
};

export async function handleLlmVerify(request: Request, env: LlmEnv): Promise<Response> {
  const cors = llmCorsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  }
  if (!isOriginAllowed(request, env)) {
    console.debug({ event: "llm_verify_origin_rejected", origin: request.headers.get("Origin") });
    return Response.json({ error: "Origin not allowed" }, { status: 403, headers: cors });
  }
  if (!withinRateLimit(request)) {
    console.warn({ event: "llm_verify_rate_limited", ip: clientAddress(request) });
    return Response.json({ error: "Too many requests" }, { status: 429, headers: cors });
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  }
  catch {
    console.debug({ event: "llm_verify_bad_json" });
    return Response.json({ error: "Malformed request body" }, { status: 400, headers: cors });
  }

  const checked = checkCredential(body.credential);
  if (!checked.ok) {
    console.debug({ event: "llm_verify_bad_credential", reason: checked.reason });
    return Response.json(
      {
        ok: false,
        error: checked.reason === "subscription_token"
          ? SUBSCRIPTION_TOKEN_MESSAGE
          : "That does not look like an Anthropic API key.",
      },
      { status: 400, headers: cors },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: authHeaders(checked.credential),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // Shallowest setting available. The answer does not matter, only that
        // the request is accepted, so there is no reason to buy thinking depth.
        output_config: { effort: "low" },
        messages: [{ role: "user", content: PROBE_PROMPT }],
      }),
    });
  }
  catch (error) {
    console.error({ event: "llm_verify_unreachable", error: String(error) });
    return Response.json(
      { ok: false, error: "Could not reach Anthropic." },
      { status: 502, headers: cors },
    );
  }

  const payload = (await upstream.json().catch(() => null)) as AnthropicResponse | null;

  if (upstream.ok) {
    console.log({ event: "llm_verify_ok", model: payload?.model });
    // Echo the model that actually answered rather than the one requested, so a
    // silent server-side substitution is visible to the player.
    return Response.json({ ok: true, model: payload?.model ?? MODEL }, { status: 200, headers: cors });
  }

  console.warn({ event: "llm_verify_rejected", upstreamStatus: upstream.status });

  // Anthropic's own wording is usually the most useful thing to show, but two
  // statuses get a plainer explanation because their raw text misleads: a 429
  // on a valid-looking key is a quota or spend-cap answer, not a bad key, and
  // saying "invalid" there would send the player hunting the wrong problem.
  const detail = payload?.error?.message;
  const message = upstream.status === 401
    ? "Anthropic rejected that key."
    : upstream.status === 429
      ? "The key works, but Anthropic is rate-limiting or has paused this account's API access."
      : detail && detail !== "Error"
        ? detail
        : `Anthropic returned ${upstream.status}.`;

  return Response.json(
    { ok: false, error: message, upstreamStatus: upstream.status },
    { status: 200, headers: cors },
  );
}
