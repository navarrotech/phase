// Settings panel for the reasoning-opponent credential.
//
// The credential is the player's own and is never stored in plaintext: it is
// posted once to the lobby Worker, which seals it, and only the sealed blob is
// kept. This component therefore never holds the value after submit, and never
// reads one back — the summary it shows is a kind plus the last four
// characters, which is all the server will return.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { StoredLlmCredential } from "../../services/llmOpponent/credentials";
import {
  deleteLlmCredential,
  isLlmOpponentAvailable,
  loadLlmCredentialSummary,
  saveLlmCredential,
} from "../../services/llmOpponent/credentials";
import { useCloudSyncStore } from "../../stores/cloudSyncStore.ts";

const BUTTON_CLASS =
  "rounded-[14px] border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50";

const INPUT_CLASS =
  "w-full rounded-[14px] border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600";

interface Props {
  /** Section chrome, passed in so this file owns no layout of its own. */
  wrapper: (props: { title: string; children: React.ReactNode }) => React.ReactElement;
}

export function ReasoningOpponentSection(props: Props) {
  const { t } = useTranslation("settings");
  const Wrapper = props.wrapper;
  const identity = useCloudSyncStore((state) => state.identity);

  const [stored, setStored] = useState<StoredLlmCredential | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStored(await loadLlmCredentialSummary());
    }
    catch (loadError) {
      console.debug("Could not read the stored model credential", { loadError });
      setStored(null);
    }
  }, []);

  useEffect(() => {
    if (!identity) {
      setStored(null);
      return;
    }
    void refresh();
  }, [identity, refresh]);

  // Hidden on deployments with no Supabase project — there is nowhere to keep
  // a credential, and the built-in AI remains the opponent.
  if (!isLlmOpponentAvailable()) return null;

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      setStored(await saveLlmCredential(draft.trim()));
      // Drop the plaintext from component state the moment it is sealed.
      setDraft("");
    }
    catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      // The service throws either a translation key it authored or a message
      // the Worker wrote to be shown verbatim.
      setError(message.startsWith("llmOpponent.") ? t(message) : message);
    }
    finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    setBusy(true);
    setError(null);
    try {
      await deleteLlmCredential();
      setStored(null);
    }
    catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    }
    finally {
      setBusy(false);
    }
  }

  return (
    <Wrapper title={t("reasoningOpponent.title")}>
      <p className="text-xs text-slate-400">{t("reasoningOpponent.description")}</p>
      <p className="text-xs text-slate-500">{t("reasoningOpponent.costNote")}</p>

      {!identity ? (
        <p className="text-xs text-slate-500">{t("reasoningOpponent.signInFirst")}</p>
      ) : stored ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-slate-200">
            {t(`reasoningOpponent.kind.${stored.kind}`)} · ····{stored.hint}
          </span>
          <button className={BUTTON_CLASS} onClick={() => void onRemove()} disabled={busy}>
            <span>{t("reasoningOpponent.remove")}</span>
          </button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave();
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
            placeholder="sk-ant-…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={t("reasoningOpponent.inputLabel")}
          />
          <p className="text-[11px] text-slate-500">{t("reasoningOpponent.inputHint")}</p>
          <button
            type="submit"
            className={`${BUTTON_CLASS} self-start`}
            disabled={busy || draft.trim().length === 0}
          >
            <span>{t("reasoningOpponent.save")}</span>
          </button>
        </form>
      )}

      {error && <p className="text-xs text-rose-400">{error}</p>}
    </Wrapper>
  );
}
