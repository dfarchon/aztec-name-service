import { translate } from "./i18n";
import { useEffect, useState } from 'react';
import type { NameRecord, RegistryReader } from '@ans/sdk/read';
import type { Holding } from '@ans/sdk';
import { CopyValue, TxLine, useTx } from './components';
import { date, errorMessage } from './format';
import { useSession } from './session';

type Modules = Awaited<ReturnType<RegistryReader['getModules']>> & {administrator?: Awaited<ReturnType<RegistryReader['getAdministrator']>>};

export function RegistryModules() {
  const { reader } = useSession();
  const [data, setData] = useState<Modules>();
  const [error, setError] = useState<string>();
  const [revision, refresh] = useState(0);
  useEffect(() => {
    let live = true;
    setData(undefined); setError(undefined);
    if (reader?.modular) void (async () => {
      const snapshot = await reader.snapshot();
      const [modules, administrator] = await Promise.all([reader.getModules(snapshot), reader.getAdministrator(snapshot)]);
      if (live) setData({...modules, administrator});
    })().catch(e => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [reader, revision]);
  if (!reader?.modular) return null;
  return <details className="card"><summary>{translate("Contract modules")}</summary>
    {data && <dl>{data.administrator && <><dt>{translate("Administrator")}</dt><dd><CopyValue value={data.administrator.toString()} /></dd></>}<dt>{translate("Registrar")}</dt><dd><CopyValue value={data.registrar.toString()} /></dd>
      <dt>{translate("Default resolver")}</dt><dd><CopyValue value={data.resolver.toString()} /></dd></dl>}
    {error && <p className="err">{translate(error)}</p>}
    <button className="ghost" onClick={() => refresh(n => n + 1)}>{translate("Refresh contract status")}</button>
  </details>;
}

export function NameModules({ holding, onDone }: { holding: Holding; onDone: () => void }) {
  const { ctx } = useSession();
  const [legacy, setLegacy] = useState<NameRecord>();
  const [resolvers, setResolvers] = useState<{ current: string; next: string }>();
  const [error, setError] = useState<string>();
  const tx = useTx();
  useEffect(() => {
    let live = true;
    setLegacy(undefined); setResolvers(undefined); setError(undefined);
    if (!ctx?.reader.modular) return;
    const read = async () => {
      if (holding.record.generation === 0) {
        const old = await ctx.reader.getLegacyName(holding.node, holding.snapshot);
        if (live && old?.generation && holding.snapshot.timestamp < old.expiresAt + 30n * 86400n) setLegacy(old);
      } else if (holding.isHolder && holding.status === 'active') {
        const [current, modules] = await Promise.all([ctx.reader.getResolver(holding.node, holding.record.generation, holding.snapshot), ctx.reader.getModules(holding.snapshot)]);
        if (live) setResolvers({ current: current.toString(), next: modules.resolver.toString() });
      }
    };
    void read().catch(e => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [ctx, holding]);
  if (!ctx?.reader.modular) return null;
  return <>
    {legacy && <section className="card">
      <h2>{translate("Migrate an existing name")}</h2><p>{translate("The expiry date is preserved. Confirm your primary name again after migration.")}</p>
      <dl><dt>{translate("Previous owner")}</dt><dd><CopyValue value={legacy.owner.toString()} /></dd><dt>{translate("Expires")}</dt><dd>{date(legacy.expiresAt)}</dd></dl>
      {legacy.owner.equals(ctx.account) ? <button disabled={tx.busy} onClick={() => void tx.exec('Migrate name', async onUpdate => {
        const { migrateName } = await import('@ans/sdk');
        await migrateName(ctx, holding.label, { onUpdate }); onDone();
      })}>{translate("Migrate to current registry")}</button> : <p className="muted">{translate("Switch to the previous owner account.")}</p>}
    </section>}
    {resolvers && <details className="card"><summary>{translate("Resolver")}</summary>
      <CopyValue value={resolvers.current} />
      {resolvers.current !== resolvers.next && <>
        <p>{translate("Set your address and primary name again after switching.")}</p>
        <button disabled={tx.busy} onClick={() => void tx.exec('Switch resolver', async onUpdate => {
          const [{ setResolver }, { AztecAddress }] = await Promise.all([import('@ans/sdk'), import('@aztec-labs/aztec.js/addresses')]);
          await setResolver(ctx, { name: holding.label, resolver: AztecAddress.fromStringUnsafe(resolvers.next) }, { onUpdate }); onDone();
        })}>{translate("Use new resolver")}</button>
      </>}
    </details>}
    {error && <p className="err">{translate(error)}</p>}
    <TxLine tx={tx} />
  </>;
}
