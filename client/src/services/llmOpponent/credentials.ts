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

/** What is kept on disk. `hint` exists so the settings row is identifiable. */
export interface StoredLlmCredential {
  credential: string;
  /** Last four characters, enough to tell two keys apart and useless alone. */
  hint: string;
  updatedAt: string;
}

/** The settings row's view: everything except the secret itself. */
export type LlmCredentialSummary = Omit<StoredLlmCredential, "credential">;

/**
 * Console API keys carry this prefix. Only they work here.
 *
 * `claude setup-token` mints a subscription OAuth credential (`sk-ant-oat…`)
 * that Anthropic authorizes for Claude Code and Claude.ai only; a direct
 * Messages API call with one is refused server-side. It is rejected by name
 * below rather than accepted and left to fail on the first decision, because
 * the two prefixes look alike and the failure would otherwise surface as an
 * opponent that silently never plays.
 */
const API_KEY_PREFIX = "sk-ant-";
const SUBSCRIPTION_TOKEN_PREFIX = "sk-ant-oat";

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
  // Checked before the general prefix: a subscription token satisfies that too.
  if (credential.startsWith(SUBSCRIPTION_TOKEN_PREFIX)) {
    console.debug("saveLlmCredential rejected a Claude Code subscription token");
    throw new Error("llmOpponent.errors.subscriptionToken");
  }
  if (!credential.startsWith(API_KEY_PREFIX)) {
    console.debug("saveLlmCredential rejected an unrecognized prefix");
    throw new Error("llmOpponent.errors.malformed");
  }

  const stored: StoredLlmCredential = {
    credential,
    hint: credential.slice(-4),
    updatedAt: new Date().toISOString(),
  };
  await set(CREDENTIAL_KEY, stored, getCredentialStore());

  return { hint: stored.hint, updatedAt: stored.updatedAt };
}

/** The settings row's metadata, or null when this device has no credential. */
export async function loadLlmCredentialSummary(): Promise<LlmCredentialSummary | null> {
  const stored = await get<StoredLlmCredential>(CREDENTIAL_KEY, getCredentialStore());
  if (!stored) return null;
  return { hint: stored.hint, updatedAt: stored.updatedAt };
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
