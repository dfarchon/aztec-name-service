import { lazy, Suspense } from "react";
import { SetupChecklist, ShareName } from "../NameExtras";
const Extensions = lazy(() => import("./Extensions").then(m => ({ default: m.Extensions })));
import { translate } from "../i18n";
import {
  clearAddress,
  clearPrimary,
  getFeeQuote,
  inspectHolding,
  renew,
  resolveAddress,
  resolvePrimary,
  setAddress,
  setPrimary,
  type Holding,
  type AddressResolution,
  type FeeQuote,
  toAnsError,
} from "@ans/sdk";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { useEffect, useState } from "react";
import { NeedsAccount } from "../App";
import { Card, CopyValue, Field, TxLine, useTx } from "../components";
import { NameModules } from "../modules";
import { FeeAmount, FeeBalance, useFeeBalance } from "../fees";
import { date, errorMessage, statusText } from "../format";
import { useSession } from "../session";
const YEAR = 365n * 86400n;

export function ManagePage({ name }: { name: string }) {
  const { ctx } = useSession();
  const [h, setH] = useState<Holding>();
  const [forward, setForward] = useState<AddressResolution>();
  const [primary, setCurrentPrimary] = useState(false);
  const [error, setError] = useState<string>();
  const [target, setTarget] = useState("");
  const [years, setYears] = useState(1);
  const [quote, setQuote] = useState<FeeQuote>();
  const [quoteError, setQuoteError] = useState<string>();
  const [quoteRevision, refreshQuote] = useState(0);
  const [revision, refresh] = useState(0);
  const canRenew = !!h?.isHolder && !h.label.parent && (h.status === "active" || h.status === "grace");
  const balance = useFeeBalance(ctx, canRenew ? quote?.feeToken.toString() : undefined);
  const tx = useTx();
  useEffect(() => {
    let live = true;
    setH(undefined);
    setError(undefined);
    setForward(undefined);
    setCurrentPrimary(false);
    if (ctx)
      ctx.reader.snapshot().then((snapshot) => Promise.all([
        inspectHolding(ctx, name, { snapshot }),
        resolveAddress(ctx.reader, name, { snapshot }),
        resolvePrimary(ctx.reader, ctx.account, snapshot),
      ]))
        .then(([holding, f, p]) => {
          if (live) {
            setH(holding);
            setForward(f);
            setCurrentPrimary(
              p.status === "verified" && p.name === holding.label.label,
            );
          }
        })
        .catch((e) => {
          if (live) setError(errorMessage(e));
        });
    return () => {
      live = false;
    };
  }, [ctx, name, revision]);
  useEffect(() => {
    let live = true;
    setQuote(undefined);
    setQuoteError(undefined);
    if (ctx && canRenew)
      getFeeQuote(ctx.reader, {
        operation: "renew",
        duration: BigInt(years) * YEAR,
        labelLength: h?.label.len,
      })
        .then((q) => {
          if (live) setQuote(q);
        })
        .catch((e) => {
          if (live) setQuoteError(errorMessage(e));
        });
    return () => {
      live = false;
    };
  }, [ctx, years, revision, quoteRevision, canRenew, h?.label.len]);
  if (!ctx) return <NeedsAccount />;
  if (error)
    return (
      <Card tone="err">
        {translate(error)}
        <button onClick={() => refresh((n) => n + 1)}>{translate("Refresh")}</button>
      </Card>
    );
  if (!h) return <Card>{translate("Loading name…")}</Card>;
  let address: AztecAddress | undefined;
  try {
    if (/^0x[0-9a-fA-F]{64}$/.test(target))
      address = AztecAddress.fromStringUnsafe(target);
  } catch {
    /* invalid input */
  }
  const active = h.status === "active";
  const isTarget =
    active &&
    forward?.status === "resolved" &&
    forward.address.equals(ctx.account);
  const done = () => refresh((n) => n + 1);
  return (
    <>
      <Card title={<CopyValue value={h.label.label} label={translate("Copy name")} />}>
        <SetupChecklist registered={active} address={forward?.status === "resolved"} primary={primary} />
        <dl>
          <dt>{translate("Status")}</dt>
          <dd>{translate(h.label.parent && !active ? "Inactive subname" : statusText[h.status])}</dd>
          <dt>{translate("Owner")}</dt>
          <dd>
            <CopyValue value={h.record.owner.toString()} label={translate("Copy owner address")} />
          </dd>
          <dt>{translate("Expires")}</dt>
          <dd>{h.record.expiresAt ? date(h.record.expiresAt) : "—"}</dd>
          <dt>{translate("Resolved address")}</dt>
          <dd>
            {forward?.status === "resolved" ? (
              <CopyValue value={forward.address.toString()} label={translate("Copy resolved address")} />
            ) : active ? (
              translate("Not set")
            ) : (
              translate("Not currently resolvable")
            )}
          </dd>
        </dl>
      </Card>
      {h.canEdit && active && (
        <Card title={translate("Resolved address")}>
          <Field
            label={translate("Aztec address")}
            hint={translate("Confirm your primary name again after changing the address.")}
          >
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={translate("0x…")}
            />
          </Field>
          <div className="row">
            <button
              disabled={!address || address.isZero() || tx.busy}
              onClick={() =>
                void tx.exec("Set address", async (onUpdate) => {
                  await setAddress(
                    ctx,
                    { name, address: address! },
                    { onUpdate },
                  ).catch(error => {
                    if (toAnsError(error).code === "fee_changed") done();
                    throw error;
                  });
                  done();
                })
              }
            >{translate("Save address")}</button>
            <button className="ghost" disabled={tx.busy || isTarget} onClick={() => void tx.exec("Use wallet address", async (onUpdate) => {
              await setAddress(ctx, { name, address: ctx.account }, { onUpdate });
              done();
            })}>{translate("Use wallet address")}</button>
            <button
              className="ghost"
              disabled={tx.busy || forward?.status !== "resolved"}
              onClick={() =>
                void tx.exec("Clear address", async (onUpdate) => {
                  await clearAddress(ctx, { name }, { onUpdate });
                  done();
                })
              }
            >{translate("Clear address")}</button>
          </div>
        </Card>
      )}
      {canRenew && (
        <Card title={translate("Renew name")}>
          <div className="row">
            <select
              aria-label={translate("Renewal period")}
              value={years}
              onChange={(e) => setYears(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((y) => (
                <option key={y} value={y}>
                  {y} {y === 1 ? translate("year") : translate("years")}
                </option>
              ))}
            </select>
            <span>{translate("Renewal fee:")}{" "}
              {quote ? <FeeAmount amount={quote.fee} token={quote.feeToken.toString()} /> : quoteError ? "—" : translate("Searching…")}
            </span>
            <button
              disabled={tx.busy || !quote || quote.duration !== BigInt(years) * YEAR || (quote.fee > 0n && (balance.balance === undefined || balance.balance < quote.fee))}
              onClick={() =>
                void tx.exec("Renew", async (onUpdate) => {
                  await renew(
                    ctx,
                    {
                      name,
                      duration: BigInt(years) * YEAR,
                      maxFee: quote!.maxFee,
                      acceptedQuote: quote,
                    },
                    { onUpdate },
                  ).catch(error => {
                    if (toAnsError(error).code === "fee_changed") refreshQuote(n => n + 1);
                    throw error;
                  });
                  done();
                })
              }
            >{translate("Confirm renewal")}</button>
          </div>
          {quote && <FeeBalance amount={quote.fee} token={quote.feeToken.toString()} read={balance} />}
              {quoteError && <p role="alert" className="err">{translate(quoteError)} <button className="ghost" onClick={() => refreshQuote(n => n + 1)}>{translate("Refresh")}</button></p>}
        </Card>
      )}
      <Card title={translate("Primary name")}>
        <p>
          {primary
            ? translate("Primary name set")
            : isTarget
              ? translate("Use this name as the default for your account.")
              : translate("Connect the wallet for the resolved address to confirm.")}
        </p>
        <div className="row">
          {isTarget && !primary && (
            <button
              disabled={tx.busy}
              onClick={() =>
                void tx.exec("Set primary name", async (onUpdate) => {
                  await setPrimary(ctx, { name }, { onUpdate });
                  done();
                })
              }
            >{translate("Set primary name")}</button>
          )}
          {primary && (
            <button
              disabled={tx.busy}
              onClick={() =>
                void tx.exec("Clear primary name", async (onUpdate) => {
                  await clearPrimary(ctx, { onUpdate });
                  done();
                })
              }
            >{translate("Clear primary name")}</button>
          )}
        </div>
      </Card>
      {h.label.parent && <p className="muted">{translate("This subname is controlled by its parent owner.")} <a href={`#/name/${h.label.parent.label}`}>{h.label.parent.label}</a></p>}
      {!ctx.reader.extended && <p className="muted">{translate("This registry supports core names. Profiles, transfers, editors and subnames require V4.")} <a href="#/docs/deployments">{translate("Networks and versions")}</a></p>}
      {ctx.reader.extended && <Suspense fallback={<p>{translate("Loading records…")}</p>}><Extensions ctx={ctx} holding={h} onDone={done}/></Suspense>}
      <ShareName name={name} />
      <NameModules holding={h} onDone={done} />
      <TxLine tx={tx} />
    </>
  );
}
