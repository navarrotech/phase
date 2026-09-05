// Shared plumbing for the LLM-opponent endpoints: who is calling, and how a
// player's API credential is kept unreadable at rest.
//
// The credential belongs to the player, never to this deployment. The Worker's
// job is to be the only place it ever exists in plaintext, and only for the
// duration of one upstream call.
//
// Sealing is AES-256-GCM under LLM_SEAL_KEY (a Worker secret), with the
// authenticated user's id as Additional Authenticated Data. The AAD binding is
// the load-bearing part: a sealed blob lifted out of another account's row
// fails to open here, because GCM authenticates the AAD and this Worker only
// ever passes the id of the caller it just verified. Row-Level Security already
// stops that read; this makes the stolen bytes worthless even if it didn't.

/** Bindings shared by every LLM-opponent route. */
export interface LlmEnv {
  /** Supabase project URL, e.g. `https://abc.supabase.co` (var, not secret). */
  SUPABASE_URL?: string;
  /** Supabase publishable/anon key — public by design (var, not secret). */
  SUPABASE_ANON_KEY?: string;
  /**
   * Base64 of 32 random bytes, the AES-256-GCM sealing key
   * (secret: `wrangler secret put LLM_SEAL_KEY`).
   *
   * Rotating it invalidates every stored credential: users re-enter theirs.
   * There is deliberately no key-id envelope — a credential is cheap to
   * replace, and versioning would mean keeping the retired key available,
   * which is the opposite of what rotation is for.
   */
  LLM_SEAL_KEY?: string;
  /** Comma-separated origin allowlist, or "*" (default) to allow any. */
  ALLOWED_ORIGINS?: string;
}

/** AES-GCM standard nonce length. 96 bits is the size GCM is defined for. */
const NONCE_BYTES = 12;

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
    "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}

/**
 * Resolve the caller's Supabase user id from their `Authorization` header.
 *
 * Verification is delegated to Supabase's own `/auth/v1/user` rather than
 * validated locally. That costs one upstream round-trip, which is free next to
 * a multi-second model call, and it avoids this Worker holding a JWT secret or
 * re-implementing JWKS rotation and algorithm selection — the two places
 * hand-rolled token verification usually goes wrong.
 *
 * Returns null for any unusable token; callers must treat that as 401.
 */
export async function resolveUserId(request: Request, env: LlmEnv): Promise<string | null> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    console.debug({ event: "llm_auth_missing_bearer" });
    return null;
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    console.error({ event: "llm_auth_unconfigured" });
    return null;
  }

  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: authorization,
      apikey: env.SUPABASE_ANON_KEY,
    },
  });
  if (!response.ok) {
    console.debug({ event: "llm_auth_rejected", upstreamStatus: response.status });
    return null;
  }

  const user = (await response.json()) as { id?: unknown };
  if (typeof user.id !== "string" || !user.id) {
    console.error({ event: "llm_auth_malformed_user" });
    return null;
  }
  return user.id;
}

async function importSealKey(env: LlmEnv): Promise<CryptoKey | null> {
  if (!env.LLM_SEAL_KEY) {
    console.error({ event: "llm_seal_key_unconfigured" });
    return null;
  }
  const raw = Uint8Array.from(atob(env.LLM_SEAL_KEY), (character) => character.charCodeAt(0));
  if (raw.byteLength !== 32) {
    console.error({ event: "llm_seal_key_wrong_length", byteLength: raw.byteLength });
    return null;
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Seal `plaintext` for `userId`. Returns base64 of `nonce || ciphertext`, or
 * null when the Worker has no usable sealing key.
 */
export async function seal(env: LlmEnv, userId: string, plaintext: string): Promise<string | null> {
  const key = await importSealKey(env);
  if (!key) return null;

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(userId),
    },
    key,
    new TextEncoder().encode(plaintext),
  );

  const packed = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  packed.set(nonce, 0);
  packed.set(new Uint8Array(ciphertext), nonce.byteLength);
  return btoa(String.fromCharCode(...packed));
}

/**
 * Open a blob sealed for `userId`. Returns null when the key is missing, the
 * blob is malformed, or GCM authentication fails — which includes the case
 * that matters: a blob sealed for a different account.
 */
export async function unseal(env: LlmEnv, userId: string, sealed: string): Promise<string | null> {
  const key = await importSealKey(env);
  if (!key) return null;

  let packed: Uint8Array;
  try {
    packed = Uint8Array.from(atob(sealed), (character) => character.charCodeAt(0));
  }
  catch {
    console.debug({ event: "llm_unseal_not_base64" });
    return null;
  }
  if (packed.byteLength <= NONCE_BYTES) {
    console.debug({ event: "llm_unseal_too_short", byteLength: packed.byteLength });
    return null;
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: packed.subarray(0, NONCE_BYTES),
        additionalData: new TextEncoder().encode(userId),
      },
      key,
      packed.subarray(NONCE_BYTES),
    );
    return new TextDecoder().decode(plaintext);
  }
  catch {
    // Authentication failure. Either the blob was tampered with, the sealing
    // key rotated, or it belongs to another account.
    console.debug({ event: "llm_unseal_auth_failed" });
    return null;
  }
}
