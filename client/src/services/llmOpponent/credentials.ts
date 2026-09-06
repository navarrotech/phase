// Storage for the player's own model API credential.
//
// The credential lives in IndexedDB, on this device only, and belongs to the
// player rather than to this deployment. There is no account, no server-side
// copy, and nothing to sign in to: the game asks for a key, keeps it locally,
// and forwards it to the lobby Worker for the duration of one upstream call.
//
// IndexedDB rather than localStorage is load-bearing. `buildBackup()` snapshots
// every user-owned localStorage key into the cloud-sync envelope AND into the
// file the "export backup" button downloads, so anything stored there ends up
// in a plaintext JSON file the player may hand to someone else. IndexedDB is
// explicitly outside that envelope (see the header of `services/backup.ts`),
// which is exactly the property a credential needs.
//
// The tradeoff, stated plainly for the settings copy: the key does not follow
// the player to another device, and clearing site data removes it.

import { createStore, del, get, set } from "idb-keyval";

/**
 * Worker base URL. Mirrors `deckUrlImport`: production points at the official
 * lobby Worker, dev uses a relative path so Vite's proxy can forward to a local
 * `wrangler dev` without CORS, and self-hosters override the env var.
 */
const LLM_API_BASE =
  import.meta.env.VITE_LLM_API_URL
  ?? import.meta.env.VITE_IMPORT_DECK_URL
  ?? (import.meta.env.DEV ? "" : "https://lobby.phase-rs.dev");

/** Its own database, so clearing it cannot disturb another cache. */
let credentialStore: ReturnType<typeof createStore> | undefined;
function getCredentialStore(): ReturnType<typeof createStore> {
  if (!credentialStore) {
    credentialStore = createStore("phase-llm-credential", "phase-llm-credential");
  }
  return credentialStore;
}

const CREDENTIAL_KEY = "anthropic";

/**
 * Which credential family the player supplied.
 *
 * The two are not interchangeable at the wire level — an API key goes on
 * `x-api-key`, an OAuth token on `Authorization: Bearer` with a beta header —
 * so the kind is classified once, here, and stored alongside the credential.
 * The Worker uses it to pick the auth header rather than re-sniffing the prefix
 * on every decision, which keeps the classification rule in one place.
 */
export type LlmCredentialKind = "api_key" | "oauth_token";

/** What is kept on disk. `hint` exists so the settings row is identifiable. */
export interface StoredLlmCredential {
  credential: string;
  kind: LlmCredentialKind;
  /** Last four characters, enough to tell two keys apart and useless alone. */
  hint: string;
  updatedAt: string;
}

/** The settings row's view: everything except the secret itself. */
export type LlmCredentialSummary = Omit<StoredLlmCredential, "credential">;

/** `claude setup-token` mints an OAuth access token; the console mints a key. */
const OAUTH_TOKEN_PREFIX = "sk-ant-oat";
const API_KEY_PREFIX = "sk-ant-";

const MIN_CREDENTIAL_LENGTH = 20;
const MAX_CREDENTIAL_LENGTH = 512;

/**
 * True when this build can offer a reasoning opponent.
 *
 * Always, now that the credential is device-local: the feature needs a Worker
 * to proxy to Anthropic and nothing else, so self-hosted builds get it too.
 * Kept as a function so the settings panel has a single place to gate on if a
 * future deployment needs to switch it off.
 */
export function isLlmOpponentAvailable(): boolean {
  return true;
}

/**
 * Validate and store a credential on this device.
 *
 * Throws with a translation key the settings panel resolves. Rejecting an
 * obviously wrong paste here rather than at the first decision means the player
 * finds out while they are looking at the field.
 */
export async function saveLlmCredential(input: string): Promise<LlmCredentialSummary> {
  const credential = input.trim();
  if (credential.length < MIN_CREDENTIAL_LENGTH || credential.length > MAX_CREDENTIAL_LENGTH) {
    console.debug("saveLlmCredential rejected an implausible length", { length: credential.length });
    throw new Error("llmOpponent.errors.malformed");
  }
  if (!credential.startsWith(API_KEY_PREFIX)) {
    console.debug("saveLlmCredential rejected an unrecognized prefix");
    throw new Error("llmOpponent.errors.malformed");
  }

  // Order matters: every OAuth token also carries the API-key prefix, so the
  // narrower test runs first.
  const kind: LlmCredentialKind = credential.startsWith(OAUTH_TOKEN_PREFIX)
    ? "oauth_token"
    : "api_key";

  const stored: StoredLlmCredential = {
    credential,
    kind,
    hint: credential.slice(-4),
    updatedAt: new Date().toISOString(),
  };
  await set(CREDENTIAL_KEY, stored, getCredentialStore());

  return { kind: stored.kind, hint: stored.hint, updatedAt: stored.updatedAt };
}

/** The settings row's metadata, or null when this device has no credential. */
export async function loadLlmCredentialSummary(): Promise<LlmCredentialSummary | null> {
  const stored = await get<StoredLlmCredential>(CREDENTIAL_KEY, getCredentialStore());
  if (!stored) return null;
  return { kind: stored.kind, hint: stored.hint, updatedAt: stored.updatedAt };
}

/**
 * The credential itself, for a game about to use a reasoning seat.
 *
 * Read once per game and held for its duration rather than per decision — a
 * decision already costs a model round-trip, and re-reading buys nothing.
 */
export async function loadLlmCredential(): Promise<StoredLlmCredential | null> {
  return (await get<StoredLlmCredential>(CREDENTIAL_KEY, getCredentialStore())) ?? null;
}

/** Remove the credential from this device. */
export async function deleteLlmCredential(): Promise<void> {
  await del(CREDENTIAL_KEY, getCredentialStore());
}

/** Base URL for the decision route, so it and this module agree. */
export function llmApiBase(): string {
  return LLM_API_BASE;
}
