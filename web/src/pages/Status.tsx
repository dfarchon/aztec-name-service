import { translate, dateLocale } from "../i18n";
import { useEffect, useState } from "react";
import { Card, CopyValue, download } from "../components";
import { config } from "../config";
import { disableNotifications, enableNotifications, notificationsEnabled, notifyIncidents } from "../monitor-notifications";
import { RegistryModules } from "../modules";
import { getVitals } from "../performance";
import { boot, useSession } from "../session";

type Health = { checkedAt: number; checks: { name: string; ok: boolean; detail: string }[]; open?: string[]; incidents: { name: string; kind: string; at: number }[]; metrics: { name: string; samples: number; average: number }[]; release: string };
const labels: Record<string, string> = { registrar: "Registrar", resolver: "Resolver", modules: "Contract modules", website: "Website", rpc: "RPC", chain: "Network identity", blocks: "Block progress", registry: "Registry", sponsor: "Fee sponsorship", balance: "Sponsor balance" };
/** Monitor details are compact machine strings; present numbers and units in plain language. */
export function humanDetail(name: string, detail: string): string {
  const number = (value: string) => Number(value).toLocaleString(dateLocale());
  const block = /^#(\d+)( · No recent blocks)?$/.exec(detail);
  if (name === "blocks" && block) return translate(block[2] ? "Latest block #{block} · no new blocks recently" : "Latest block #{block}", { block: number(block[1]) });
  const balance = /^(\d+) Fee Juice$/.exec(detail);
  if (name === "balance" && balance) return translate("{amount} Fee Juice left to pay network fees for users", { amount: number(balance[1]) });
  const chain = /^Sepolia · runtime (.+)$/.exec(detail);
  if (name === "chain" && chain) return translate("Aztec Testnet on Ethereum Sepolia · node version {version}", { version: chain[1] });
  return translate(detail);
}

export function StatusPage() {
  const s = useSession();
  const [health, setHealth] = useState<Health>();
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState<string>();
  const [notify, setNotify] = useState(notificationsEnabled);
  const [notificationError, setNotificationError] = useState<string>();
  const [revision, refresh] = useState(0);
  useEffect(() => {
    let live = true;
    const read = async () => {
      if (document.hidden && !notify) return;
      try {
        const r = await fetch("/api/status", { cache: "no-store", signal: AbortSignal.timeout(10000) });
        if (!r.ok || !r.headers.get("content-type")?.includes("application/json")) throw new Error();
        const data: Health = await r.json();
        if (live) { setHealth(data); setError(undefined); if (notify) notifyIncidents(data.incidents, labels); }
      } catch { if (live) setError("Monitoring is unavailable"); }
      finally { if (live) setNow(Date.now()); }
    };
    void read(); const timer = setInterval(() => void read(), 30000);
    document.addEventListener("visibilitychange", read);
    return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", read); };
  }, [revision, notify]);
  return <>
    <Card title={translate("Service health")}>
      {health && <>
        <p className={!health.checkedAt || now - health.checkedAt > 180000 ? "warn" : "muted"}>{!health.checkedAt ? translate("Current release has not been checked") : <>{now - health.checkedAt > 180000 ? translate("Monitoring data is stale") : translate("Checked every minute")} · {new Date(health.checkedAt).toLocaleString(dateLocale())}</>}</p>
        <dl>{health.checks.map(c => <div className="status-row" key={c.name}><dt>{translate(labels[c.name] ?? c.name)}</dt><dd className={c.ok ? "ok" : "err"}>{c.ok ? translate("Operational") : translate("Unavailable")} · {humanDetail(c.name, c.detail)}</dd></div>)}</dl>
      </>}
      {error && <p className="warn">{translate(error)}</p>}
      <button className="ghost" onClick={() => refresh(n => n + 1)}>{translate("Refresh status")}</button>
      <button className="ghost" onClick={async () => {
        try {
          if (notify) { disableNotifications(); setNotify(false); }
          else if (await enableNotifications()) { setNotify(true); setNotificationError(undefined); }
          else setNotificationError("Allow notifications in your browser settings.");
        } catch { setNotificationError("Notifications are not supported by this browser."); }
      }}>{notify ? translate("Disable notifications") : translate("Enable notifications")}</button>
      {notify && <small className="muted">{translate("Notifications are active while this page is open.")}</small>}
      {notificationError && <small className="warn">{translate(notificationError)}</small>}
    </Card>
    <Card title={translate("Incidents")}>
      {health?.checkedAt ? <><h3>{translate("Current issues")}</h3>{health.open?.length ? health.open.map(name => <p className="err" key={name}>{translate(labels[name] ?? name)} · {translate("Ongoing issue")}</p>) : <p className="muted">{translate("No ongoing issues")}</p>}</> : <p className="muted">{translate("Current release has not been checked")}</p>}
      <h3>{translate("Event history")}</h3>
      {health?.incidents.length ? health.incidents.map((e, i) => <p key={`${e.at}:${i}`} className="muted">{translate(labels[e.name] ?? e.name)} · {e.kind === "changed" ? translate("Changed") : e.kind === "recovered" ? translate("Recovered") : translate("Incident started")} · {new Date(e.at).toLocaleString(dateLocale())}</p>) : <p className="muted">{translate("No incidents")}</p>}
    </Card>
    <RegistryModules />
    <details className="card"><summary>{translate("Diagnostics and performance")}</summary>
      <dl><dt>{translate("Version")}</dt><dd>{config.release}</dd><dt>{translate("RPC")}</dt><dd>{config.nodeUrl}</dd><dt>{translate("Registry")}</dt><dd>{config.registry && <CopyValue value={config.registry.toString()} />}</dd><dt>{translate("Connection latency")}</dt><dd>{s.connection?.latencyMs ?? "—"}{translate("ms")}</dd></dl>
      {health?.metrics.map(m => <p key={m.name}>{translate(m.samples === 1 ? "{name} · average {value} · {count} sample" : "{name} · average {value} · {count} samples", { name: m.name, value: `${m.average.toFixed(2)}${m.name === "CLS" ? "" : " ms"}`, count: m.samples })}</p>)}
      <button className="ghost" onClick={() => download("ans-diagnostics.json", JSON.stringify({ release: config.release, connection: s.connection, node: config.nodeUrl, registry: config.registry?.toString(), vitals: getVitals(), monitor: health }, null, 2))}>{translate("Export diagnostics")}</button>
      <button className="ghost" onClick={() => void boot()}>{translate("Reconnect")}</button>
    </details>
  </>;
}
