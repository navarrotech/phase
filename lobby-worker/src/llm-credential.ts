// POST /llm/credential — seal a player's own model API credential.
//
// The client posts the raw credential exactly once, gets back an opaque sealed
// blob, and writes that blob to its own RLS-scoped `llm_credentials` row. This
// Worker stores nothing: it is the holder of the sealing key, not of the
// credentials. See `llm-session.ts` for why the seal is bound to the caller.

import type { LlmEnv } from "./llm-session";

import { llmCorsHeaders, resolveUserId, seal } from "./llm-session";

/**
 * Which credential family the caller supplied.
 *
 * The two are not interchangeable at the wire level — an API key goes on
 * `x-api-key`, an OAuth token on `Authorization: Bearer` with a beta header —
 * so the kind is classified once, here, and carried alongside the sealed bytes
 * rather than re-derived by prefix sniffing on every decision.
 */
export type CredentialKind = "api_key" | "oauth_token";

type RequestBody = {
  provider?: unknown;
  credential?: unknown;
};

/**
 * `claude setup-token` mints an OAuth access token; the console mints an API
 * key. Anthropic's prefixes distinguish them unambiguously.
 */
const OAUTH_TOKEN_PREFIX = "sk-ant-oat";
const API_KEY_PREFIX = "sk-ant-";

/** Guards against a paste that is obviously not a credential. */
const MIN_CREDENTIAL_LENGTH = 20;
const MAX_CREDENTIAL_LENGTH = 512;

export async function handleLlmCredential(request: Request, env: LlmEnv): Promise<Response> {
  const cors = llmCorsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  }
  if (!env.LLM_SEAL_KEY) {
    // Reaching this in production means the LLM opponent is silently off for
    // every user, so it is an error rather than a debug line.
    console.error({ event: "llm_credential_unconfigured" });
    return Response.json(
      { error: "LLM opponent not configured: set the LLM_SEAL_KEY secret." },
      { status: 503, headers: cors },
    );
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
    console.debug({ event: "llm_credential_bad_json" });
    return Response.json({ error: "Malformed request body" }, { status: 400, headers: cors });
  }

  // Only Anthropic ships today. The check is explicit rather than a passthrough
  // so a typo cannot land a row the decision route will never match.
  if (body.provider !== "anthropic") {
    console.debug({ event: "llm_credential_unknown_provider", provider: String(body.provider) });
    return Response.json({ error: "Unsupported provider" }, { status: 400, headers: cors });
  }

  const credential = typeof body.credential === "string" ? body.credential.trim() : "";
  if (credential.length < MIN_CREDENTIAL_LENGTH || credential.length > MAX_CREDENTIAL_LENGTH) {
    console.debug({ event: "llm_credential_bad_length", length: credential.length });
    return Response.json(
      { error: "That does not look like an Anthropic credential." },
      { status: 400, headers: cors },
    );
  }
  if (!credential.startsWith(API_KEY_PREFIX)) {
    console.debug({ event: "llm_credential_bad_prefix" });
    return Response.json(
      { error: "Expected an Anthropic key starting with sk-ant-." },
      { status: 400, headers: cors },
    );
  }

  // Order matters: every OAuth token also starts with the API-key prefix, so
  // the narrower test runs first.
  const kind: CredentialKind = credential.startsWith(OAUTH_TOKEN_PREFIX)
    ? "oauth_token"
    : "api_key";

  const sealed = await seal(env, userId, credential);
  if (!sealed) {
    console.error({ event: "llm_credential_seal_failed" });
    return Response.json({ error: "Could not secure the credential" }, { status: 500, headers: cors });
  }

  console.log({ event: "llm_credential_sealed", kind });

  return Response.json(
    {
      sealed,
      kind,
      // Enough for the settings screen to tell two keys apart, and useless to
      // anyone who obtains it.
      hint: credential.slice(-4),
    },
    { status: 200, headers: cors },
  );
}
