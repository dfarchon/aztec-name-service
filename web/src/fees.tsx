import { translate } from "./i18n";
import { useEffect, useState } from "react";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { readFeeTokenMetadata, type RegistryReader } from "@ans/sdk/read";
import type { AnsContext } from "@ans/sdk";
import { useSession } from "./session";
import { formatUnits } from "./usability";

/** Balance stays in memory and is read only through the selected account's wallet. */
export async function readFeeBalance(ctx: AnsContext, token: string): Promise<bigint> {
  const { getPrivateFeeBalance } = await import("@ans/sdk");
  return getPrivateFeeBalance(ctx, AztecAddress.fromStringUnsafe(token));
}

export function useFeeBalance(ctx: AnsContext | undefined, token: string | undefined) {
  const [revision, refresh] = useState(0);
  const [read, setRead] = useState<{ ctx: AnsContext; token: string; balance?: bigint; failed?: boolean }>();
  useEffect(() => {
    let live = true;
    setRead(undefined);
    if (ctx && token) void readFeeBalance(ctx, token)
      .then(balance => { if (live) setRead({ ctx, token, balance }); })
      .catch(() => { if (live) setRead({ ctx, token, failed: true }); });
    return () => { live = false; };
  }, [ctx, token, revision]);
  const current = read?.ctx === ctx && read?.token === token ? read : undefined;
  return { balance: current?.balance, failed: current?.failed, refresh: () => refresh(n => n + 1) };
}

export function FeeBalance({ amount, token, read }: { amount: bigint; token: string; read: ReturnType<typeof useFeeBalance> }) {
  if (amount === 0n) return null;
  return <div className="fee-readiness" aria-live="polite">
    <p>{translate("Private payment balance:")} {read.balance !== undefined ? <FeeAmount amount={read.balance} token={token} freeLabel={false} /> : translate(read.failed ? "Balance could not be checked. Retry in your wallet." : "Checking balance in wallet…")}</p>
    {read.balance !== undefined && read.balance < amount && <p className="warn">{translate("Insufficient registration fee token balance. Fund this account before starting.")}</p>}
    <button className="ghost" onClick={read.refresh}>{translate("Check balance again")}</button>
  </div>;
}

type TokenInfo = { decimals: number; symbol: string };
const cache = new WeakMap<RegistryReader, Map<string, Promise<TokenInfo>>>();
async function tokenInfo(reader: RegistryReader, token: string): Promise<TokenInfo> {
  let tokens = cache.get(reader);
  if (!tokens) cache.set(reader, tokens = new Map());
  if (tokens.has(token)) return tokens.get(token)!;
  const pending = (async () => {
    return readFeeTokenMetadata(reader, AztecAddress.fromStringUnsafe(token));
  })();
  tokens.set(token, pending);
  pending.catch(() => tokens!.delete(token));
  return pending;
}

export function FeeAmount({ amount, token, freeLabel = true }: { amount: bigint; token: string; freeLabel?: boolean }) {
  const { reader, connection } = useSession();
  const [info, setInfo] = useState<TokenInfo>();
  useEffect(() => {
    let live = true;
    setInfo(undefined);
    if (reader && (amount !== 0n || !freeLabel)) void tokenInfo(reader, token).then(i => { if (live) setInfo(i); }).catch(() => {});
    return () => { live = false; };
  }, [reader, token, amount, freeLabel, connection?.failures]);
  if (amount === 0n && freeLabel) return <>{translate("Free")}</>;
  return <span title={translate("{count} base units", { count: amount.toString() })}>
    {info ? `${formatUnits(amount, info.decimals)} ${info.symbol}` : translate("{count} base units", { count: amount.toString() })}
  </span>;
}
