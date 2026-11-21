import { translate } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { Fr } from "@aztec-labs/aztec.js/fields";
import type {
  DiscoverySession,
  WalletProvider,
  PendingConnection,
} from "@aztec-labs/wallet-sdk/manager";
import { choosingAccount, connectExternal, lock, selectAccount, useSession, WalletStepError } from "./session";
import { errorMessage, shortAddr } from "./format";
import { config } from "./config";

/** When the discovery panel starts explaining what the wallet may be waiting for. */
const WALLET_WAIT_HINT_MS = 8000;

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
  // A wallet answers discovery only once it is unlocked and admits the request, which can take the whole window.
  const [waitingLong, setWaitingLong] = useState(false);
  const waitingTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(
    () => () => {
      generation.current++;
      discovery.current?.cancel();
      clearTimeout(waitingTimer.current);
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
    setWaitingLong(false);
    clearTimeout(waitingTimer.current);
    waitingTimer.current = setTimeout(() => {
      if (generation.current === g) setWaitingLong(true);
    }, WALLET_WAIT_HINT_MS);
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
        appId: "fog-public-names",
        // Nulo asks the user to approve the connection during discovery; keep the SDK's 60 s window.
        timeout: 60000,
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
      if (g === generation.current) {
        clearTimeout(waitingTimer.current);
        setSearching(false);
        setWaitingLong(false);
      }
    }
  };
  const begin = async (provider: WalletProvider) => {
    setBusy(true);
    setError(undefined);
    setWebWalletVisible(provider.type === "web");
    if (provider.type === "web" && webWalletPanel.current) webWalletPanel.current.open = true;
    try {
      const connection =
        await provider.establishSecureChannel("fog-public-names",
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
    console.error("[Fog wallet] connection failed", e);
    if (e instanceof WalletStepError) {
      const raw = e.cause instanceof Error ? e.cause.message : String(e.cause);
      return `${translate("Wallet connection failed at step:")} ${e.step}. ${raw.split("\n")[0].slice(0, 240)}`;
    }
    const raw = e instanceof Error ? e.message : String(e);
    if (/Key exchange timeout/.test(raw))
      return translate(
        config.network === "mainnet"
          ? "The wallet did not respond in time. Unlock it, select Aztec mainnet and try again."
          : "The wallet did not respond in time. Unlock it, select the testnet and try again.",
      );
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
  const needsAccountSelection = choosingAccount(s);
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
      }}>{s.ctx ? shortAddr(s.ctx.account) : translate(!s.wallet ? "Connect wallet" : needsAccountSelection ? "Choose account" : "Switching wallet account…")}</summary>
      <div className="wallet-popover">
      <h2>{s.wallet ? translate("Connected wallet") : translate("Connect wallet")}</h2>
      {needsAccountSelection && <p role="status">{translate("Choose a wallet account to continue.")}</p>}
      {s.ctx || needsAccountSelection ? (
        <div className="row">
          <select
            aria-label={translate("Wallet account")}
            value={s.ctx?.account.toString() ?? ""}
            disabled={!canConnect || busy || s.pendingTxs > 0}
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
          {s.pendingTxs > 0 && <p role="status">Finish the pending transaction before switching accounts.</p>}
          <button className="ghost" disabled={busy} onClick={() => void lock()}>{translate("Disconnect wallet")}</button>
        </div>
      ) : (
        <>
          {s.wallet && <p role="status">{translate("Switching wallet account…")}</p>}
          <button
            disabled={!canConnect || searching || busy || !!pending}
            onClick={() => void search()}
          >
            {translate(!searching ? "Find wallets again" : providers.length ? "Looking for other wallets…" : "Finding wallets…")}
          </button>
          {searching && waitingLong && !providers.length && (
            <p role="status" className="muted">{translate("Still waiting for your wallet. Open it, unlock it and approve the connection request if it shows one. Close any wallet windows left open by earlier attempts.")}</p>
          )}
          {!pending &&
            providers.map((p) => (
              <button disabled={!canConnect || busy} key={p.id} onClick={() => void begin(p)}>
                {p.name}
              </button>
            ))}
          {!searching && !busy && !s.wallet && discovery.current && !providers.length && (
            <div><p>{translate(config.network === "mainnet" ? "No compatible wallet found. Open this site in the browser where your wallet is installed, unlock it and select Aztec mainnet." : "No compatible wallet found. Open this site in the browser where your wallet is installed, unlock it and select the matching testnet.")} {translate("If the wallet is ready, close its windows from earlier connection attempts, wait a minute and try again.")}</p><a href="https://nulo.sh" target="_blank" rel="noopener noreferrer">{translate("Install Nulo for Chrome or Firefox")}</a><p><a href="#/docs/getting-started">{translate(config.network === "mainnet" ? "Wallet setup guide" : "Wallet and testnet setup")}</a></p></div>
          )}
        </>
      )}
      {pending && (
        <div className="card">
          <p>{translate("Verify wallet connection")}</p>
          <p className="muted">{translate("To make sure you are connecting to your real wallet, check that these symbols match the ones shown in the wallet pop-up.")}</p>
          <strong>{pending.emoji}</strong>
          <div className="row">
            <button disabled={!canConnect || busy} onClick={() => void confirm()}>{translate("Confirm and connect")}</button>
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
