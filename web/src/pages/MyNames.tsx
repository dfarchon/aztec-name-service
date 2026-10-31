import { favoriteKey, readFavorites, downloadCalendar } from "../portfolio";
import { FavoriteButton } from "../NameExtras";
import { translate } from "../i18n";
import { listOwnedNames, type NamesCursor, type OwnedName } from "@ans/sdk";
import { useEffect, useRef, useState } from "react";
import { go, NeedsAccount } from "../App";
import { Card, CopyValue, EmptyState } from "../components";
import { leaseDays, leaseText } from "../usability";
import { date, errorMessage, statusText } from "../format";
import { useSession } from "../session";
import { ActivityPage } from "./Activity";

export function MyNamesPage() {
  const { ctx, reader } = useSession();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [reminders, setReminders] = useState(false);
  const [reminderError, setReminderError] = useState("");
  const remindersRef = useRef(reminders); remindersRef.current = reminders;
  const sent = useRef(new Set<string>());
  const favoritesKey = reader ? favoriteKey(reader.deployment.chainId, reader.registry.toString()) : "";
  useEffect(() => { const update = () => setFavorites(favoritesKey ? readFavorites(favoritesKey) : []); update(); window.addEventListener("ans:favorites", update); window.addEventListener("storage", update); return () => { window.removeEventListener("ans:favorites", update); window.removeEventListener("storage", update); }; }, [favoritesKey]);
  const [names, setNames] = useState<OwnedName[]>([]);
  const [cursor, setCursor] = useState<NamesCursor>();
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const epoch = useRef(0);
  const loadingEpoch = useRef<number>();
  const loadedChunks = useRef(1);
  const load = async (next?: NamesCursor, g = epoch.current) => {
    if (!ctx || g !== epoch.current || loadingEpoch.current === g) return;
    loadingEpoch.current = g;
    setBusy(true);
    setError(undefined);
    try {
      // Refresh every loaded chunk at one fresh snapshot, including later pages.
      const r = await listOwnedNames(ctx.reader, ctx.account, { cursor: next, maxPages: next ? 4 : loadedChunks.current * 4 });
      if (g !== epoch.current) return;
      if (next) loadedChunks.current++;
      setNames((old) => [
        ...new Map(
          [...(next ? old : []), ...r.names].map((n) => [n.node, n]),
        ).values(),
      ]);
      if (remindersRef.current && typeof Notification !== "undefined" && Notification.permission === "granted") {
        for (const n of r.names) {
          const id = `${ctx.account}:${favoritesKey}:${n.node}:${n.generation}:${n.expiresAt}`;
          if (n.expiresAt - r.snapshot.timestamp <= 30n * 86400n && !sent.current.has(id)) {
            try { new Notification(translate("Name renewal reminder"), { body: `${n.name} · ${date(n.expiresAt)}`, tag: id }); sent.current.add(id); } catch { setReminderError("Notifications are unavailable in this browser."); }
          }
        }
      }
      setCursor(r.cursor);
      setComplete(r.status === "complete");
    } catch (e) {
      if (g === epoch.current) setError(errorMessage(e));
    } finally {
      if (loadingEpoch.current === g) loadingEpoch.current = undefined;
      if (g === epoch.current) setBusy(false);
    }
  };
  useEffect(() => {
    const g = ++epoch.current;
    loadedChunks.current = 1;
    setNames([]);
    setCursor(undefined);
    setComplete(false);
    setError(undefined);
    setBusy(false);
    setReminders(false);
    remindersRef.current = false;
    setReminderError("");
    void load(undefined, g);
    return () => {
      epoch.current++;
    };
  }, [ctx]);
  useEffect(() => { if (!reminders || !ctx) return; const timer = setInterval(() => { if (!busy) void load(); }, 60000); return () => clearInterval(timer); }, [ctx, reminders, busy]);
  const favoriteCard = reader && <Card title={translate("Favorites")}>{favorites.length ? favorites.map(name => <div className="name-row" key={name}><a href={`#/name/${encodeURIComponent(name)}`}>{name}</a><FavoriteButton reader={reader} name={name}/></div>) : <p className="muted">{translate("Save names from search to keep them here.")}</p>}</Card>;
  if (!ctx) return <>{favoriteCard}<NeedsAccount /></>;
  const visible = names.filter(n => n.name.includes(query.toLowerCase().trim()) && (filter === "all" || filter === "favorites" && favorites.includes(n.name) || filter === "expiring" && leaseDays(n.expiresAt) <= 30 || n.status === filter));
  return (
    <>
      <Card title={translate("Owned names")}>
        <div className="portfolio-tools"><input type="search" aria-label={translate("Search your names")} placeholder={translate("Search your names")} value={query} onChange={e => setQuery(e.target.value)}/><select aria-label={translate("Filter names")} value={filter} onChange={e => setFilter(e.target.value)}>{[["all","All names"],["active","Active"],["grace","Grace period"],["expiring","Expiring within 30 days"],["favorites","Favorites"]].map(([value,label]) => <option key={value} value={value}>{translate(label)}</option>)}</select></div>
        {[...visible].sort((a, b) => Number(a.expiresAt - b.expiresAt) || a.name.localeCompare(b.name)).map((n) => (
          <div className="name-row" key={n.node.toString()}>
            <CopyValue value={n.name} label={translate("Copy name")} />
            <span className={leaseDays(n.expiresAt) <= 30 ? "warn" : ""} title={date(n.expiresAt)}>
              {translate(statusText[n.status])} · {leaseText(n.expiresAt)}
            </span>
            <FavoriteButton reader={ctx.reader} name={n.name}/><button onClick={() => go("manage", n.name)}>{translate("Manage")}</button>
          </div>
        ))}
        {!busy && !!names.length && !visible.length && <p>{translate("No names match these filters.")}</p>}
        {busy && <p>{translate("Searching…")}</p>}
        {complete && !names.length && !error && (
          <EmptyState title={translate("No names yet")} description={translate("This wallet does not own any names yet.")}>
            <a className="button" href="#/">{translate("Search available names")}</a>
          </EmptyState>
        )}
        {error && <p className="err">{translate(error)}</p>}
        {!complete && !busy && cursor && (
          <button onClick={() => void load(cursor)}>{translate("Load more")}</button>
        )}
        <button
          className="ghost"
          disabled={busy}
          onClick={() => {
            setComplete(false);
            setCursor(undefined);
            void load();
          }}
        >{translate("Refresh list")}</button>
      </Card>
      <Card title={translate("Expiry reminders")}><p className="muted">{translate("Import a calendar for reminders when the site is closed. Browser reminders require this page to stay open.")}</p><div className="row"><button disabled={!names.length || busy} onClick={() => downloadCalendar(names, `${favoritesKey}:${ctx.account}`)}>{translate("Export expiry calendar")}</button><button className="ghost" onClick={async () => { if (reminders) { remindersRef.current = false; setReminders(false); return; } const requestedEpoch = epoch.current; try { if (typeof Notification === "undefined") throw new Error(); const permission = await Notification.requestPermission(); if (requestedEpoch !== epoch.current) return; if (permission !== "granted") throw new Error(); setReminders(true); setReminderError(""); } catch { if (requestedEpoch === epoch.current) setReminderError("Notifications are unavailable or permission was denied. Use the calendar instead."); } }}>{translate(reminders ? "Disable expiry reminders" : "Enable expiry reminders")}</button></div>{!complete && !!names.length && <small>{translate("Only loaded names are included. Load all pages before exporting.")}</small>}{reminderError && <p role="alert">{translate(reminderError)}</p>}</Card>
      {favoriteCard}
      <details>
        <summary>{translate("Activity")}</summary>
        <ActivityPage />
      </details>
    </>
  );
}
