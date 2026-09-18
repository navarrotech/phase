import type { LlmOpponentHealth } from "../services/llmOpponentClient";

import { useEffect, useState } from "react";

import { probeLlmOpponent } from "../services/llmOpponentClient";

/**
 * One-shot probe of the local LLM opponent sidecar, run when the setup menu
 * mounts.
 *
 * Deliberately not polled. The sidecar is a process the developer starts and
 * stops by hand, and a background poll would spend a request every few seconds
 * for the entire life of a menu that is usually looked at for ten. A stale
 * "reachable" answer costs nothing: the adapter falls back to the built-in AI
 * for any decision the sidecar cannot serve.
 *
 * `null` means "not reachable", which the caller renders as a disabled toggle
 * with a reason rather than hiding the feature — a toggle that vanishes when
 * its backend is down is indistinguishable from one that was never built.
 */
export function useLlmOpponentHealth() {
  const [health, setHealth] = useState<LlmOpponentHealth | null>(null);
  const [probed, setProbed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void probeLlmOpponent().then((result) => {
      if (cancelled) return;
      setHealth(result);
      setProbed(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return { health, probed } as const;
}
