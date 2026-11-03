import { FavoriteButton, ShareName, PublicRecords } from "../NameExtras";
import { translate } from "../i18n";
import {
  type AddressResolution,
  getAvailability,
  normalizeName,
  resolveAddress,
} from "@ans/sdk/read";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { go } from "../App";
import { Card, CopyValue } from "../components";
import { config } from "../config";
import { date, errorMessage, statusText } from "../format";
import { rpcRetryInfo, type RpcRetryInfo } from "../rpc";
import { useSession } from "../session";

type Result = Awaited<ReturnType<typeof getAvailability>> & {
  display: AddressResolution;
};

export function SearchPage({ initial }: { initial?: string }) {
  const { reader, status } = useSession();
  const [input, setInput] = useState(initial ?? "");
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<{ message: string; retry?: RpcRetryInfo }>();
  const generation = useRef(0);
  const route = useRef(initial);
  const loadedRoute = useRef<{ name: string; reader: typeof reader }>();
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const [loading, setLoading] = useState(false);

  // Normalization is local and instant; the query only runs on explicit request.
  const preview = useMemo(() => {
    if (!input.trim()) return undefined;
    try {
      return {
        label: normalizeName(input, { suffix: config.nameSuffix, allowSubnames: reader?.extended }).label,
      };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }, [input, reader]);

  const query = useCallback(async (name = input) => {
    if (!reader) return;
    const g = ++generation.current;
    setLoading(true);
    setError(undefined);
    setResult(undefined);
    try {
      const info = await getAvailability(reader, name, {
        suffix: config.nameSuffix,
      });
      const display = await resolveAddress(reader, info.label, { snapshot: info.snapshot });
      if (g !== generation.current) return;
      setResult({ ...info, display });
      if (window.location.hash !== `#/name/${info.label.label}`) {
        route.current = info.label.label;
        loadedRoute.current = { name: info.label.label, reader };
        setInput(info.label.label);
        go("name", info.label.label);
      }
    } catch (e) {
      // A failed read is "unknown", never "available".
      if (g === generation.current) setError({ message: errorMessage(e), retry: rpcRetryInfo(e) });
    } finally {
      if (g === generation.current) setLoading(false);
    }
  }, [input, reader]);

  useEffect(() => {
    if (route.current === initial) return;
    route.current = initial;
    generation.current++;
    setInput(initial ?? "");
    setResult(undefined);
    setError(undefined);
    setLoading(false);
    loadedRoute.current = undefined;
  }, [initial]);
  useEffect(() => {
    if (!initial || input !== initial || !reader || !["ready", "locked"].includes(status)) return;
    if (loadedRoute.current?.name === initial && loadedRoute.current.reader === reader) return;
    loadedRoute.current = { name: initial, reader };
    void query(initial);
  }, [initial, input, reader, status, query]);

  return (
    <>
      <Card className="search-card">
        <label className="search-label" htmlFor="name-query">{translate("Name")}</label>
        <form
          className="row search-form"
          aria-busy={loading}
          onSubmit={(e) => {
            e.preventDefault();
            void query();
          }}
        >
          <input
            id="name-query"
            autoFocus
            aria-label={translate("Name")}
            aria-invalid={!!preview && "error" in preview}
            aria-describedby="search-feedback"
            value={input}
            placeholder={translate("Enter a name, e.g. alice")}
            onChange={(e) => {
              generation.current++;
              setInput(e.target.value);
              setResult(undefined);
              setError(undefined);
              setLoading(false);
            }}
          />
          <button
            className="primary"
            disabled={!reader || loading || !preview || "error" in preview}
          >
            {loading ? translate("Searching…") : translate("Search")}
          </button>
        </form>
        <div id="search-feedback" className="field-feedback" aria-live="polite">
        {preview &&
          ("error" in preview ? (
            <small className="err">{translate(preview.error)}</small>
          ) : (
            preview.label !== input.trim() && <small>{translate("Search for:")} {preview.label}</small>
          ))}
        {!reader && <small>{status === "offline" ? translate("Node unavailable. Reconnect and retry.") : status === "misconfigured" ? translate("Network configuration error") : translate("Connecting to network…")}</small>}
        </div>
      </Card>

      {error && <Card tone="err"><div role="alert" data-query-error>
        <p>{error.retry?.temporary
          ? translate(error.retry.timeout ? "The node temporarily timed out. Automatically retried {count} times. Please try again shortly." : "The node is temporarily unavailable. Automatically retried {count} times. Please try again shortly.", { count: error.retry.retryCount })
          : translate(error.message)}</p>
        <p>{translate("Node connection status is checked separately; this lookup failed.")}</p>
        <button disabled={!reader || loading || !preview || "error" in preview} onClick={() => void query()}>{translate("Retry")}</button>
      </div></Card>}

      {result && (
        <Card title={<CopyValue value={result.label.label} label={translate("Copy name")} />} meta={<span className="status-badge">{result.migration ? translate("Migration required") : result.available ? translate("Available") : result.status === "active" ? translate("Registered · Active") : translate(result.label.parent ? "Inactive subname" : statusText[result.status])}</span>}>
          {(result.status !== "unregistered" || !result.available) && <dl>
            {result.status !== "unregistered" && (
              <>
                <dt>{translate("Expires")}</dt>
                <dd>{result.record.expiresAt ? date(result.record.expiresAt) : "—"}</dd>
                <dt>{translate("Owner")}</dt>
                <dd><CopyValue value={result.record.owner.toString()} label={translate("Copy owner address")} /></dd>
              </>
            )}
            {!result.available && <>
            <dt>{translate("Resolved address")}</dt>
            <dd>
              {result.display.status === "resolved"
                ? <CopyValue value={result.display.address.toString()} label={translate("Copy resolved address")} />
                : translate("Not set")}
            </dd>
            </>}
          </dl>}
          <div className="row name-actions">
            {reader && <FavoriteButton reader={reader} name={result.label.label} />}
            {result.migration && <button onClick={() => go("manage", result.label.label)}>{translate("Migrate name")}</button>}
            {result.available && (
              <button className="primary" onClick={() => go("register", result.label.label)}>{translate("Register name")}</button>
            )}
            {result.status === "active" || result.status === "grace" ? (
              <button
                className="ghost"
                onClick={() => go("manage", result.label.label)}
              >{translate("Manage name")}</button>
            ) : null}
          </div>
          <ShareName name={result.label.label} />
        </Card>
      )}
      {reader && result?.status === "active" && <PublicRecords reader={reader} node={result.node} generation={result.record.generation} snapshot={result.snapshot} />}
    </>
  );
}
