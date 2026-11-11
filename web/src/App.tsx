import { translate } from "./i18n";
import { WalletConnection, openWalletPanel } from "./WalletConnection";
import { Card, EmptyState } from "./components";
import { config } from "./config";
import { lazy, Suspense, useEffect, useState } from "react";

const AccountPage = lazy(() =>
  import("./pages/Account").then((m) => ({ default: m.AccountPage })),
);
const ManagePage = lazy(() => import("./pages/Manage").then((m) => ({ default: m.ManagePage })));
const MyNamesPage = lazy(() => import("./pages/MyNames").then((m) => ({ default: m.MyNamesPage })));
const RegisterPage = lazy(() => import("./pages/Register").then((m) => ({ default: m.RegisterPage })));
import { SearchPage } from "./pages/Search";
import { boot, choosingAccount, useSession } from "./session";
import { TransactionWatch } from "./transactions";
import { RouteBoundary } from "./RouteBoundary";
const DocsPage = lazy(() => import("./pages/Docs").then(m => ({ default: m.DocsPage })));
const ChangelogPage = lazy(() => import("./pages/Docs").then(m => ({ default: m.ChangelogPage })));
const StatusPage = lazy(() => import("./pages/Status").then(m => ({ default: m.StatusPage })));

/** Hash routes keep names out of server logs; only public name pages are meant to be shared. */
function useRoute(): [string, string | undefined] {
  const read = () => {
    const [, page = "", arg] = window.location.hash.split("/");
    let decoded = arg;
    try {
      if (arg) decoded = decodeURIComponent(arg);
    } catch { /* Invalid shared URLs still reach name validation instead of crashing React. */ }
    return [page, decoded || undefined] as [string, string | undefined];
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (page: string, arg?: string) => {
  window.location.hash = arg
    ? `/${page}/${encodeURIComponent(arg)}`
    : `/${page}`;
};

const NAV: [string, string][] = [
  ["", "Search"],
  ["names", "My names"],
  ["docs", "Docs"],
];

const PAGE_TITLES: Record<string, string> = {
  "": "Name search", name: "Name details", names: "My names",
  docs: "Documentation", help: "Help", changelog: "Changelog",
  manage: "Manage name", register: "Register a name", status: "Service status", account: "Developer wallet",
};

export function App() {
  const s = useSession();
  const [page, arg] = useRoute();
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === "light" ? "light" : "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("ans:theme", theme); } catch { /* Theme remains usable without storage. */ }
  }, [theme]);

  return (
    <div className="app">
      <div className="fog" aria-hidden="true" />
      <a className="skip-link" href="#content" onClick={e => { e.preventDefault(); document.getElementById("content")?.focus(); }}>{translate("Skip to content")}</a>
      <header className="app-header">
        <a className="product-name" href="#/">{translate("Aztec Name Service")}</a>
        <nav aria-label={translate("Main navigation")}>
          {NAV.map(([p, label]) => (
            <a key={p} className={page === p || (p === "" && page === "name") ? "on" : ""} aria-current={page === p || (p === "" && page === "name") ? "page" : undefined} href={`#/${p}`}>
              {translate(label)}
            </a>
          ))}
        </nav>
        <div className="header-actions" role="group" aria-label={translate("Wallet and appearance")}>
          <WalletConnection />
          <button type="button" className="ghost theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? translate("Switch to light mode") : translate("Switch to dark mode")}>{theme === "dark" ? translate("Light") : translate("Dark")}</button>
        </div>
        <span className="who">
          {s.status === "offline" && <span className="err">{translate("Node unavailable")}</span>}
          {s.status === "misconfigured" && <span className="err">{translate("Configuration error")}</span>}
        </span>
      </header>
      {s.error && s.status !== "locked" && (
        <div className="banner err" role="alert">{s.status === "offline" ? translate("Connection lost. Retrying…") : translate(s.error)}
          {["offline", "misconfigured"].includes(s.status) && <button className="ghost" onClick={() => void boot()}>{translate("Reconnect")}</button>}
        </div>
      )}
      <main id="content" tabIndex={-1} className={page === 'docs' || page === 'help' ? 'docs-page' : undefined}>
        {page !== 'docs' && page !== 'help' && page !== '' && <div className="page-heading"><h1>{translate(PAGE_TITLES[page] ?? "Name service")}</h1></div>}
        <RouteBoundary key={page} resetKey={`${page}:${arg ?? ''}`}>
        <Suspense fallback={<CardLoading />}>
        {page === "" && <SearchPage initial={arg} page="home" />}
        {page === "name" && <SearchPage initial={arg} />}
        {page === "status" && <StatusPage />}
        {page === "docs" && <DocsPage article={arg} />}
        {page === "help" && <DocsPage help />}
        {page === "changelog" && <ChangelogPage />}
        {page === "register" && (
          <RegisterPage key={`${s.ctx?.account}:${arg}`} initial={arg} />
        )}
        {page === "names" && <MyNamesPage />}
        {page === "manage" && arg && (
          <ManagePage key={`${s.ctx?.account}:${arg}`} name={arg} />
        )}
        {config.developmentWallet && page === "account" && (
          <Suspense fallback={<p>{translate("Loading developer wallet…")}</p>}>
            <AccountPage />
          </Suspense>
        )}
        </Suspense>
        </RouteBoundary>
      </main>
      <footer><nav aria-label={translate("Resources")}><a href="#/help">{translate("Help")}</a><a href="#/status">{translate("Status")}</a><a href="#/docs/sdk">{translate("SDK")}</a><a href="#/changelog">{translate("Changelog")}</a></nav><span className="footer-note">{translate("Names and address records are public")}</span><a href="#/status" className="network-status">{s.status === "offline" ? translate("Node unavailable") : s.status === "misconfigured" ? translate("Network configuration error") : s.reader ? translate("Node connected · periodic check") : translate("Connecting to network")}</a>
      </footer>
      <TransactionWatch />
    </div>
  );
}

function CardLoading() {
  return <div className="card" role="status">{translate("Loading page…")}</div>;
}

/** Shown by pages that need an unlocked wallet with an account. */
export function NeedsAccount() {
  const s = useSession();
  if (choosingAccount(s)) return <ChooseAccount />;
  const { reader } = s;
  return (
    <Card>
      <EmptyState title={translate("Wallet not connected")} description={translate("Connect your wallet to view and manage your names.")}>
        <button disabled={!reader} onClick={openWalletPanel}>{translate("Connect wallet")}</button>
        {config.developmentWallet && <a href="#/account">{translate("Open developer wallet")}</a>}
      </EmptyState>
    </Card>
  );
}

export function ChooseAccount() {
  return (
    <Card>
      <EmptyState title={translate("Choose a wallet account")} description={translate("Choose a wallet account to continue.")}>
        <button onClick={openWalletPanel}>{translate("Choose account")}</button>
      </EmptyState>
    </Card>
  );
}
