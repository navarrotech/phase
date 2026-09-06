// Shared HTTP layer for the reasoning-opponent routes.
//
// Both routes are unauthenticated by design: every caller supplies their own
// Anthropic credential, so there is no session to verify and no per-player
// state to protect. What they DO share is a need to bound who can point at
// them, since serving a stranger costs request quota even when it costs no
// secrets. These guards are that bound, and each is honest about its reach.

/** Bindings the reasoning-opponent routes read. */
export interface LlmEnv {
  /** Comma-separated origin allowlist, or "*" (default) to allow any. */
  ALLOWED_ORIGINS?: string;
}

/** Wire version for the Messages API. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Console API keys are the only credential this accepts.
 *
 * A `claude setup-token` credential (`sk-ant-oat…`) is authorized by Anthropic
 * for Claude Code and Claude.ai only and is refused on `/v1/messages`. Worse,
 * it is refused as a rate-limit error rather than an auth error, so accepting
 * one yields an opponent that silently never plays. Both routes reject the
 * prefix by name and say what to use instead.
 */
export const SUBSCRIPTION_TOKEN_PREFIX = "sk-ant-oat";
export const API_KEY_PREFIX = "sk-ant-";

export const SUBSCRIPTION_TOKEN_MESSAGE =
  "Claude subscription tokens cannot be used for API requests. "
  + "Use a console API key from console.anthropic.com.";

/** Outcome of checking a caller-supplied credential's shape. */
export type CredentialCheck =
  | { ok: true; credential: string }
  | { ok: false; reason: "missing" | "subscription_token" };

export function checkCredential(value: unknown): CredentialCheck {
  if (typeof value !== "string" || !value.startsWith(API_KEY_PREFIX)) {
    return { ok: false, reason: "missing" };
  }
  // Narrower test first: a subscription token also carries the key prefix.
  if (value.startsWith(SUBSCRIPTION_TOKEN_PREFIX)) {
    return { ok: false, reason: "subscription_token" };
  }
  return { ok: true, credential: value };
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

export function clientAddress(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

export function authHeaders(credential: string): Record<string, string> {
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
