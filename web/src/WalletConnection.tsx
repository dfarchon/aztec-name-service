import { translate } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { Fr } from "@aztec-labs/aztec.js/fields";
import type {
  DiscoverySession,
  WalletProvider,
  PendingConnection,
} from "@aztec-labs/wallet-sdk/manager";
import { connectExternal, lock, selectAccount, useSession, WalletStepError } from "./session";
import { errorMessage, shortAddr } from "./format";
import { config } from "./config";

export function openWalletPanel() {
  const menu = document.getElementById("wallet-menu") as HTMLDetailsElement | null;
  if (!menu) return;
  const trigger = menu.querySelector("summary");
  if (!menu.open) trigger?.click();
  trigger?.focus();
}

export function WalletConnection() {
  const s = useSession();
  const canConnect = !!s.reader && !["booting", "offline", "misconfigured"].includes(s.status);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  const [providers, setProviders] = useState<WalletProvider[]>([]);
  const [pending, setPending] = useState<{
    provider: WalletProvider;
    connection: PendingConnection;
    emoji: string;
  }>();
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [webWalletVisible, setWebWalletVisible] = useState(false);
  const webWalletHost = useRef<HTMLDivElement>(null);
  const webWalletPanel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (s.walletMode === undefined) setWebWalletVisible(false);
  }, [s.walletMode]);
  const discovery = useRef<DiscoverySession>();
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      discovery.current?.cancel();
    },
    [],
  );
  const attempt = useRef<PendingConnection>();
  useEffect(() => () => attempt.current?.cancel(), []);
  const search = async () => {
    if (!s.reader) return;
    discovery.current?.cancel();
    const g = ++generation.current;
    setProviders([]);
    setSearching(true);
    setError(undefined);
    try {
      const { WalletManager } = await import("@aztec-labs/wallet-sdk/manager");
      const d = WalletManager.configure({
        extensions: { enabled: true },
        webWallets: config.webWalletUrls.length
          ? { urls: config.webWalletUrls }
          : undefined,
      }).getAvailableWallets({
        chainInfo: {
          chainId: new Fr(s.reader.deployment.chainId),
          version: new Fr(s.reader.deployment.rollupVersion),
        },
        appId: "ans-public-names",
        timeout: 15000,
        onWalletDiscovered: (p) => {
          if (generation.current === g)
            setProviders((old) => [...old.filter((x) => x.id !== p.id), p]);
        },
      });
      discovery.current = d;
      await d.done;
    } catch (e) {
      if (g === generation.current) setError(errorMessage(e));
    } finally {
      if (g === generation.current) setSearching(false);
    }
  };
  const begin = async (provider: WalletProvider) => {
    setBusy(true);
    setError(undefined);
    setWebWalletVisible(provider.type === "web");
    if (provider.type === "web" && webWalletPanel.current) webWalletPanel.current.open = true;
    try {
      const connection =
        await provider.establishSecureChannel("ans-public-names",
          provider.type === "web" ? { container: webWalletHost.current } : undefined);
      attempt.current = connection;
      const { hashToEmoji } = await import("@aztec-labs/wallet-sdk/crypto");
      setPending({ provider, connection, emoji: hashToEmoji(connection.verificationHash) });
    } catch (e) {
      await provider.disconnect().catch(() => {});
      setWebWalletVisible(false);
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  };
  /** Wallet setup never sends a transaction, so show which step failed and the wallet's own message. */
  const walletError = (e: unknown) => {
    console.error("[ANS wallet] connection failed", e);
    if (e instanceof WalletStepError) {
      const raw = e.cause instanceof Error ? e.cause.message : String(e.cause);
      return `${translate("Wallet connection failed at step:")} ${e.step}. ${raw.split("\n")[0].slice(0, 240)}`;
    }
    const raw = e instanceof Error ? e.message : String(e);
    if (/Key exchange timeout/.test(raw))
      return translate("The wallet did not respond in time. Unlock it, select the testnet and try again.");
    return errorMessage(e);
  };
  const confirm = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const wallet = await pending.connection.confirm();
      attempt.current = undefined;
      const { needsAccountSelection } = await connectExternal(wallet, pending.provider);
      discovery.current?.cancel();
      setPending(undefined);
      setProviders([]);
      // Several granted accounts: keep the panel open so the user picks one explicitly.
      if (menu.current && needsAccountSelection) menu.current.open = true;
    } catch (e) {
      pending.connection.cancel();
      attempt.current = undefined;
      setPending(undefined);
      setWebWalletVisible(false);
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  };
  // The wallet granted several accounts and none is selected yet (see connectExternal).
  const choosingAccount = !s.ctx && !!s.wallet && s.accounts.length > 1;
  return (
    <details id="wallet-menu" className="wallet-connection" ref={menu} onKeyDown={event => {
      if (event.key === "Escape" && menu.current?.open) {
        event.preventDefault(); menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    }}>
      <summary className="wallet-trigger" aria-label={s.wallet ? translate("Wallet account") : translate("Connect wallet")} aria-disabled={!s.wallet && !canConnect} onClick={event => {
        if (!s.wallet && !canConnect) { event.preventDefault(); return; }
        if (!menu.current?.open && !s.wallet && canConnect && !searching && !busy && !pending) void search();
      }}>{s.ctx ? shortAddr(s.ctx.account) : translate(!s.wallet ? "Connect wallet" : choosingAccount ? "Choose account" : "Switching wallet account…")}</summary>
      <div className="wallet-popover">
      <h2>{s.wallet ? translate("Connected wallet") : translate("Connect wallet")}</h2>
      {choosingAccount && <p role="status">{translate("Choose a wallet account to continue.")}</p>}
      {s.ctx || choosingAccount ? (
        <div className="row">
          <select
            aria-label={translate("Wallet account")}
            value={s.ctx?.account.toString() ?? ""}
            disabled={busy}
            onChange={async (e) => {
              const a = s.accounts.find(
                (a) => a.address.toString() === e.target.value,
              );
              if (!a) return;
              setBusy(true);
              setError(undefined);
              try {
                await selectAccount(a.address);
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {!s.ctx && <option value="" disabled>{translate("Choose account")}</option>}
            {s.accounts.map((a) => (
              <option key={a.address.toString()} value={a.address.toString()}>
                {a.alias || shortAddr(a.address)}
              </option>
            ))}
          </select>
          <button className="ghost" disabled={busy} onClick={() => void lock()}>{translate("Disconnect wallet")}</button>
        </div>
      ) : (
        <>
          {s.wallet && <p role="status">{translate("Switching wallet account…")}</p>}
          <button
            disabled={!canConnect || searching || busy || !!pending}
            onClick={() => void search()}
          >
            {searching ? translate("Finding wallets…") : translate("Find wallets again")}
          </button>
          {!pending &&
            providers.map((p) => (
              <button disabled={busy} key={p.id} onClick={() => void begin(p)}>
                {p.name}
              </button>
            ))}
          {!searching && !busy && !s.wallet && discovery.current && !providers.length && (
            <div><p>{translate("No compatible wallet found. Open this site in the browser where your wallet is installed, unlock it and select the matching testnet.")}</p><a href="https://azguardwallet.io/help/azguard-wallet/introducing" target="_blank" rel="noopener noreferrer">{translate("Install Azguard for Chrome")}</a><p><a href="#/docs/getting-started">{translate("Wallet and testnet setup")}</a></p></div>
          )}
        </>
      )}
      {pending && (
        <div className="card">
          <p>{translate("Verify wallet connection")}</p>
          <p className="muted">{translate("To make sure you are connecting to your real wallet, check that these symbols match the ones shown in the wallet pop-up.")}</p>
          <strong>{pending.emoji}</strong>
          <div className="row">
            <button disabled={busy} onClick={() => void confirm()}>{translate("Confirm and connect")}</button>
            <button
              disabled={busy}
              onClick={() => {
                attempt.current?.cancel();
                attempt.current = undefined;
                setPending(undefined);
                setWebWalletVisible(false);
              }}
            >{translate("Cancel")}</button>
          </div>
        </div>
      )}
      <details ref={webWalletPanel} hidden={!webWalletVisible} open className="web-wallet-panel">
        <summary>{translate("Web wallet")}</summary>
        <div ref={webWalletHost} className="web-wallet-host" />
      </details>
      {error && <small className="err">{translate(error)}</small>}
      </div>
    </details>
  );
}
