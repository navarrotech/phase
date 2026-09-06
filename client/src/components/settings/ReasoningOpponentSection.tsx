// Settings panel for the reasoning-opponent credential.
//
// The credential is the player's own and stays on this device. There is no
// account and nothing to sign in to. This component drops the plaintext from
// its own state the moment it is stored, and never reads it back — the summary
// it renders is only the key's last four characters.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LlmCredentialSummary } from "../../services/llmOpponent/credentials";
import {
  deleteLlmCredential,
  isLlmOpponentAvailable,
  loadLlmCredential,
  loadLlmCredentialSummary,
  saveLlmCredential,
  verifyLlmCredential,
} from "../../services/llmOpponent/credentials";

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

  const [stored, setStored] = useState<LlmCredentialSummary | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; text: string } | null>(null);

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
    void refresh();
  }, [refresh]);

  if (!isLlmOpponentAvailable()) return null;

  /** Resolve a service message: a translation key it authored, or server prose. */
  function messageText(message: string): string {
    return message.startsWith("llmOpponent.") ? t(message) : message;
  }

  async function runCheck(credential: string) {
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await verifyLlmCredential(credential);
      setCheckResult(
        result.ok
          ? { ok: true, text: t("reasoningOpponent.checkOk", { model: result.model }) }
          : { ok: false, text: messageText(result.message) },
      );
    }
    finally {
      setChecking(false);
    }
  }

  async function onCheckStored() {
    const credential = await loadLlmCredential();
    if (!credential) {
      console.debug("onCheckStored found no stored credential");
      return;
    }
    await runCheck(credential.credential);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    setCheckResult(null);
    try {
      const credential = draft.trim();
      setStored(await saveLlmCredential(credential));
      // Drop the plaintext from component state the moment it is stored.
      setDraft("");
      // Prove it works now rather than three turns into a game.
      await runCheck(credential);
    }
    catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      setError(messageText(message));
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
      setCheckResult(null);
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
      <p className="text-xs text-slate-500">{t("reasoningOpponent.deviceNote")}</p>

      {stored ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-slate-200">
            {t("reasoningOpponent.storedKey", { hint: stored.hint })}
          </span>
          <div className="flex gap-2">
            <button
              className={BUTTON_CLASS}
              onClick={() => void onCheckStored()}
              disabled={busy || checking}
            >
              <span>{checking ? t("reasoningOpponent.checking") : t("reasoningOpponent.check")}</span>
            </button>
            <button className={BUTTON_CLASS} onClick={() => void onRemove()} disabled={busy || checking}>
              <span>{t("reasoningOpponent.remove")}</span>
            </button>
          </div>
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

      {checking && !checkResult && (
        <p className="text-xs text-slate-400">{t("reasoningOpponent.checking")}</p>
      )}
      {checkResult && (
        <p className={`text-xs ${checkResult.ok ? "text-emerald-400" : "text-amber-400"}`}>
          {checkResult.text}
        </p>
      )}
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </Wrapper>
  );
}
