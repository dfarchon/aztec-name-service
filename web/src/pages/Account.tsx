import { translate } from "../i18n";
import { seal } from "@ans/sdk";
import { useState } from "react";

import { Card, download, Field } from "../components";
import { errorMessage, shortAddr } from "../format";
import {
  type AccountKeys,
  createAccount,
  lock,
  selectAccount,
  unlock,
  useSession,
} from "../session";
import { hasVault } from "../vault";

export function AccountPage() {
  const s = useSession();
  if (s.status === "booting") return <Card>{translate("Connecting to network…")}</Card>;
  if (s.status === "offline" || s.status === "misconfigured")
    return <Card tone="err">{translate(s.error)}</Card>;
  if (s.status === "locked" || s.status === "unlocking") return <Unlock />;
  return <Accounts />;
}

function Unlock() {
  const s = useSession();
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const first = !hasVault();
  const ok = pass.length >= 8 && (!first || pass === confirm);
  return (
    <Card title={first ? translate("Create local wallet") : translate("Unlock local wallet")}>
      <p className="muted">{translate("Keys and private state are encrypted with your passphrase and stored in this browser. They are never sent to a server. If you forget your passphrase, recovery requires an exported account key.")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void unlock(pass);
        }}
      >
        <Field label={translate("Passphrase (at least 8 characters)")}>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoFocus
          />
        </Field>
        {first && (
          <Field label={translate("Confirm passphrase")}>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
        )}
        <button disabled={!ok || s.status === "unlocking"}>
          {s.status === "unlocking" ? translate("Starting wallet…") : first ? translate("Create") : translate("Unlock")}
        </button>
      </form>
      {s.error && <small className="err">{translate(s.error)}</small>}
    </Card>
  );
}

function Accounts() {
  const s = useSession();
  const [alias, setAlias] = useState("");
  const [importKeys, setImportKeys] = useState<AccountKeys>({
    secret: "",
    salt: "",
    signingKey: "",
  });
  const [exportPass, setExportPass] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const valid = (v: string) => /^0x[0-9a-fA-F]{1,64}$/.test(v);

  return (
    <>
      <Card title={translate("Account")}>
        {s.accounts.length === 0 && <p className="muted">{translate("No accounts yet.")}</p>}
        <ul className="accounts">
          {s.accounts.map((a) => (
            <li
              key={a.address.toString()}
              className={s.ctx?.account.equals(a.address) ? "on" : ""}
            >
              <span>{a.alias || translate("Untitled")}</span>
              <code>{shortAddr(a.address)}</code>
              <button
                className="ghost"
                disabled={busy}
                onClick={() => run(() => selectAccount(a.address))}
              >
                {s.ctx?.account.equals(a.address) ? translate("Current") : translate("Switch")}
              </button>
            </li>
          ))}
        </ul>
        <div className="row">
          <input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder={translate("Account label (local only)")}
          />
          <button
            disabled={busy}
            onClick={() => run(() => createAccount(alias || "account"))}
          >{translate("Create account")}</button>
          <button className="ghost" onClick={() => void lock()}>{translate("Lock")}</button>
        </div>
        {error && <small className="err">{translate(error)}</small>}
      </Card>

      {s.records?.keys && (
        <Card title={translate("Export account key")} tone="warn">
          <p>{translate("Use this backup to recover your account and names on another device. The file is encrypted with a separate passphrase.")}</p>
          <div className="row">
            <input
              type="password"
              placeholder={translate("Export passphrase (at least 8 characters)")}
              value={exportPass}
              onChange={(e) => setExportPass(e.target.value)}
            />
            <button
              disabled={exportPass.length < 8}
              onClick={async () =>
                download(
                  `ans-account-${s.ctx!.account.toString().slice(2, 10)}.json`,
                  JSON.stringify(await seal(s.records!.keys, exportPass)),
                )
              }
            >{translate("Export encrypted backup")}</button>
          </div>
        </Card>
      )}

      <Card title={translate("Import account")}>
        {(["secret", "salt", "signingKey"] as const).map((k) => (
          <Field key={k} label={k}>
            <input
              value={importKeys[k]}
              onChange={(e) =>
                setImportKeys({ ...importKeys, [k]: e.target.value.trim() })
              }
              placeholder={translate("0x…")}
            />
          </Field>
        ))}
        <button
          disabled={busy || !Object.values(importKeys).every(valid)}
          onClick={() => run(() => createAccount("imported", importKeys))}
        >{translate("Import")}</button>
      </Card>
    </>
  );
}
