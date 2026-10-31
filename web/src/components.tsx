import { translate } from "./i18n";
import { type TxUpdate } from "@ans/sdk";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { errorMessage, txStateText } from "./format";
import { getSession, txRecorder } from "./session";

export function Card({
  title,
  children,
  tone,
  meta,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  tone?: "warn" | "ok" | "err";
}) {
  return (
    <section className={`card ${tone ?? ""}`}>
      {title && <div className="card-heading"><h2>{title}</h2>{meta}</div>}
      {children}
    </section>
  );
}

export function EmptyState({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="empty-state">
    <h2>{title}</h2>
    {description && <p className="muted">{description}</p>}
    {children}
  </div>;
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/**
 * Runs one SDK transaction with a status line, a history entry, and double-submit protection. `run` receives the
 * SDK `onUpdate` callback.
 */
export function useTx() {
  const [update, setUpdate] = useState<TxUpdate>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const running = useRef(false);
  const exec = async <T,>(
    label: string,
    run: (onUpdate: (u: TxUpdate) => void) => Promise<T>,
  ): Promise<T | undefined> => {
    if (running.current) return;
    if (["offline", "misconfigured", "booting"].includes(getSession().status)) {
      setError("Network not ready. Reconnect and retry.");
      return;
    }
    running.current = true;
    setBusy(true);
    setError(undefined);
    setUpdate(undefined);
    setStartedAt(Date.now());
    const record = txRecorder(label);
    try {
      return await run((u) => {
        setUpdate(u);
        record(u);
      });
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return {
    exec,
    busy,
    update,
    startedAt,
    error,
    reset: () => (setUpdate(undefined), setError(undefined)),
  };
}

export function TxLine({ tx }: { tx: ReturnType<typeof useTx> }) {
  if (!tx.update && !tx.error) return null;
  return (
    <div className={`txline ${tx.error ? "err" : ""}`}>
      {tx.update && <span>{translate(txStateText[tx.update.state])}</span>}
      {tx.busy && tx.startedAt && <Elapsed since={tx.startedAt} />}
      {tx.update?.txHash && (
        <CopyValue value={tx.update.txHash} label={translate("Copy transaction hash")} />
      )}
      {tx.error && <span>{translate(tx.error)}</span>}
    </div>
  );
}

export function CopyValue({ value, label = "Copy", text = value }: { value: string; label?: string; text?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { setCopied(false); setError(false); }, [value]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setError(false); }
    catch { setError(true); }
  };
  return <span className="copy-value">
    <code>{text}</code>
    <button className="ghost copy-button" type="button" aria-label={translate(label)} onClick={() => void copy()}>{copied ? translate("Copied") : translate("Copy")}</button>
    {error && <small className="err">{translate("Copy failed. Copy the value manually.")}</small>}
  </span>;
}

export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <span className="muted">{translate("{count} s", { count: Math.max(0, Math.floor((now - since) / 1000)) })}</span>;
}

export function download(filename: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
