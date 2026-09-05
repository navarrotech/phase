// Asks the lobby Worker for a reasoner's choice, and builds the static context
// that makes the choice informed.
//
// This module carries no game logic. The brief it forwards is the engine's, the
// candidate list inside it is the engine's, and the index that comes back is
// turned into a proposal by pairing it with the engine's own token — never by
// constructing an action here. Every failure path returns null so the caller
// falls back to the built-in AI: a bad network or a confused model should cost
// one weaker move, never a stuck game.

import type { LlmCandidate, LlmDecisionBrief } from "../../adapter/types";
import type { SealedLlmCredential } from "./credentials";
import type { Session } from "@supabase/supabase-js";

import { getSupabaseClient } from "../cloudSync/supabaseClient";
import { getSharedAdapter } from "../../adapter/wasm-adapter";
import { llmApiBase } from "./credentials";

/** The reasoner's answer: an index into the brief, plus why. */
export interface LlmChoice {
  candidate: LlmCandidate;
  reasoning: string;
}

/**
 * How long to wait on one decision.
 *
 * Deliberately generous. A reasoning pass on a complicated board legitimately
 * takes tens of seconds, and the alternative to waiting is a worse move — the
 * player opted into a slower, stronger opponent. The ceiling exists only so a
 * hung request eventually releases the seat to the local AI.
 */
const DECISION_TIMEOUT_MS = 180_000;

export async function requestLlmChoice(
  credential: SealedLlmCredential,
  deckContext: string,
  brief: LlmDecisionBrief,
): Promise<LlmChoice | null> {
  // `getSupabaseClient` throws on an unconfigured build. Reaching here without
  // Supabase should be impossible — a credential could not have been loaded —
  // but a thrown error here would count as a controller failure rather than
  // falling back, so it is handled like every other unavailability.
  let session: Session | null = null;
  try {
    session = (await getSupabaseClient().auth.getSession()).data.session;
  }
  catch (error) {
    console.debug("requestLlmChoice could not read a Supabase session", { error });
    return null;
  }
  if (!session) {
    console.debug("requestLlmChoice has no Supabase session; deferring to local AI");
    return null;
  }

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), DECISION_TIMEOUT_MS);

  try {
    const response = await fetch(`${llmApiBase()}/llm/decide`, {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        sealed: credential.sealed,
        kind: credential.kind,
        deckContext,
        brief,
      }),
    });

    const body = (await response.json().catch(() => null)) as
      | { index?: number; reasoning?: string; error?: string }
      | null;

    if (!response.ok || typeof body?.index !== "number") {
      console.debug("LLM decision unavailable; falling back to local AI", {
        status: response.status,
        error: body?.error,
      });
      return null;
    }

    // The Worker already range-checks against the brief it was sent. Re-checking
    // against the brief we hold closes the gap where the two disagree, which is
    // the only way an out-of-domain index could reach the submit path.
    const candidate = brief.candidates[body.index];
    if (!candidate) {
      console.debug("LLM returned an index outside the local brief", { index: body.index });
      return null;
    }

    return { candidate, reasoning: body.reasoning ?? "" };
  }
  catch (error) {
    console.debug("LLM decision request failed; falling back to local AI", { error });
    return null;
  }
  finally {
    clearTimeout(timeout);
  }
}

/**
 * Build the static prefix the reasoner sees once per game: every card in the
 * seat's deck with the engine's own parse of it.
 *
 * The parse tree, not just Oracle text, is the point. It carries a `supported`
 * flag per clause, so the reasoner learns what this engine actually implements
 * for a card and stops planning around a clause the parser dropped. Oracle text
 * alone would invite exactly that mistake.
 *
 * The result is byte-stable for a given decklist, which is what lets the Worker
 * put a cache breakpoint after it — every later decision in the game reads the
 * whole block back from cache instead of re-sending it.
 */
export async function buildDeckContext(cardNames: string[]): Promise<string> {
  const adapter = getSharedAdapter();
  // Sorted and de-duplicated so two orderings of the same deck produce the same
  // bytes. An unstable prefix silently disables prompt caching.
  const unique = [...new Set(cardNames)].sort();

  const entries = await Promise.all(
    unique.map(async (cardName) => {
      const [face, parseDetails] = await Promise.all([
        adapter.getCardFaceData(cardName).catch(() => null),
        adapter.getCardParseDetails(cardName).catch(() => null),
      ]);
      return { cardName, face, parseDetails };
    }),
  );

  const known = entries.filter((entry) => entry.face || entry.parseDetails);
  if (known.length < unique.length) {
    console.debug("buildDeckContext skipped cards the engine could not resolve", {
      requested: unique.length,
      resolved: known.length,
    });
  }

  return [
    "Your deck for this game. Each card carries the engine's own parse of its",
    "abilities. A clause marked `supported: false` is NOT implemented by this",
    "engine — do not build a plan that depends on it.",
    "",
    JSON.stringify(known),
  ].join("\n");
}
