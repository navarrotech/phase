// Storage for the player's own model API credential.
//
// The credential never exists in plaintext anywhere this module can reach. The
// browser posts it once to the lobby Worker (`/llm/credential`), which seals it
// under a key only the Worker holds and bound to this account; only the sealed
// blob comes back, and only the sealed blob is stored.
//
// It lives in its own `llm_credentials` table rather than in preferences, and
// that placement is load-bearing. `buildBackup()` snapshots every user-owned
// localStorage key into the cloud-sync envelope AND into the file the "export
// backup" button downloads — anything reachable from preferences ends up in a
// plaintext JSON file the user may hand to someone else. A credential must
// never take that path.

import type { Session } from "@supabase/supabase-js";

import { getSupabaseClient, isSupabaseConfigured } from "../cloudSync/supabaseClient";

/**
 * Worker base URL. Mirrors `deckUrlImport`: production points at the official
 * lobby Worker, dev uses a relative path so Vite's proxy can forward to a local
 * `wrangler dev` without CORS, and self-hosters override the env var.
 */
const LLM_API_BASE =
  import.meta.env.VITE_LLM_API_URL
  ?? import.meta.env.VITE_IMPORT_DECK_URL
  ?? (import.meta.env.DEV ? "" : "https://lobby.phase-rs.dev");

const CREDENTIALS_TABLE = "llm_credentials";

/** The only provider wired today. Widening this is a Worker + schema change. */
export const LLM_PROVIDER = "anthropic" as const;

/**
 * Which credential family the Worker classified the input as. An `sk-ant-oat…`
 * token from `claude setup-token` authenticates differently from a console API
 * key, and the Worker needs to know which without unsealing.
 */
export type LlmCredentialKind = "api_key" | "oauth_token";

/** What the settings screen shows about a stored credential. */
export interface StoredLlmCredential {
  kind: LlmCredentialKind;
  /** Last four characters, so two keys are distinguishable. */
  hint: string;
  updatedAt: string;
}

/** The sealed material plus the routing kind, as sent on every decision. */
export interface SealedLlmCredential {
  sealed: string;
  kind: LlmCredentialKind;
}

/**
 * True when this build can offer an LLM opponent at all. Requires Supabase
 * (the credential's home) — self-hosted builds without it fall back to the
 * built-in AI, which is the whole product without this feature.
 */
export function isLlmOpponentAvailable(): boolean {
  return isSupabaseConfigured();
}

async function requireSession(): Promise<Session> {
  const { data } = await getSupabaseClient().auth.getSession();
  if (!data.session) {
    throw new Error("llmOpponent.errors.signedOut");
  }
  return data.session;
}

/**
 * Seal `credential` at the Worker and store the result on this account.
 *
 * Throws with a translation key for conditions the UI should explain, or with
 * the Worker's own message when it authored one worth showing verbatim (an
 * unrecognized key prefix, for instance).
 */
export async function saveLlmCredential(credential: string): Promise<StoredLlmCredential> {
  const session = await requireSession();

  const response = await fetch(`${LLM_API_BASE}/llm/credential`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ provider: LLM_PROVIDER, credential }),
  });

  const body = (await response.json().catch(() => null)) as
    | { sealed?: string; kind?: LlmCredentialKind; hint?: string; error?: string }
    | null;

  if (!response.ok || !body?.sealed || !body.kind || body.hint === undefined) {
    console.debug("saveLlmCredential rejected by worker", { status: response.status });
    throw new Error(body?.error ?? "llmOpponent.errors.sealFailed");
  }

  const updatedAt = new Date().toISOString();
  const { error } = await getSupabaseClient()
    .from(CREDENTIALS_TABLE)
    .upsert(
      {
        user_id: session.user.id,
        provider: LLM_PROVIDER,
        kind: body.kind,
        sealed: body.sealed,
        hint: body.hint,
        updated_at: updatedAt,
      },
      { onConflict: "user_id,provider" },
    );
  if (error) throw error;

  return { kind: body.kind, hint: body.hint, updatedAt };
}

/**
 * Read the stored credential's display metadata, or null when this account has
 * none. Deliberately does not select `sealed` — the settings screen has no use
 * for it, and a column it never reads is a column it cannot leak.
 */
export async function loadLlmCredentialSummary(): Promise<StoredLlmCredential | null> {
  if (!isLlmOpponentAvailable()) return null;

  const { data, error } = await getSupabaseClient()
    .from(CREDENTIALS_TABLE)
    .select("kind, hint, updated_at")
    .eq("provider", LLM_PROVIDER)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  return {
    kind: data.kind as LlmCredentialKind,
    hint: data.hint as string,
    updatedAt: data.updated_at as string,
  };
}

/**
 * Fetch the sealed blob for a game about to use an LLM seat.
 *
 * Read once per game and held for its duration rather than re-read per
 * decision: RLS makes the read safe but not free, and a decision already costs
 * a model round-trip.
 */
export async function loadSealedLlmCredential(): Promise<SealedLlmCredential | null> {
  if (!isLlmOpponentAvailable()) return null;

  const { data, error } = await getSupabaseClient()
    .from(CREDENTIALS_TABLE)
    .select("sealed, kind")
    .eq("provider", LLM_PROVIDER)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  return { sealed: data.sealed as string, kind: data.kind as LlmCredentialKind };
}

/** Remove the stored credential for this account. */
export async function deleteLlmCredential(): Promise<void> {
  const session = await requireSession();
  const { error } = await getSupabaseClient()
    .from(CREDENTIALS_TABLE)
    .delete()
    .eq("user_id", session.user.id)
    .eq("provider", LLM_PROVIDER);
  if (error) throw error;
}

/** Base URL for the decision route, so it and the credential route agree. */
export function llmApiBase(): string {
  return LLM_API_BASE;
}
