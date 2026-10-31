import { translate, dateLocale, activityLabel } from "../i18n";

import { NeedsAccount } from "../App";
import { Card, CopyValue, Elapsed } from "../components";
import { txStateText } from "../format";
import { useSession } from "../session";
import { refreshTransaction } from "../transactions";
import { PENDING_TX } from "../usability";

const OPEN = new Set([
  "submitted",
  "included",
  "unknown",
  "reorged",
  "proving",
  "simulating",
  "awaiting_wallet",
]);

export function ActivityPage() {
  const { records, ctx } = useSession();
  if (!records || !ctx) return <NeedsAccount />;

  // Looks the receipt up by hash; never resends.

  return (
    <Card title={translate("Activity")}>
      {records.txs.length === 0 && <p className="muted">{translate("No transactions yet.")}</p>}
      <table>
        <tbody>
          {records.txs.map((t) => (
            <tr key={t.id}>
              <td>{new Date(t.at).toLocaleString(dateLocale())}</td>
              <td>{activityLabel(t.label)}</td>
              <td
                className={
                  t.state === "reverted" || t.state === "dropped" ? "err" : ""
                }
              >
                {translate(txStateText[t.state])}
                {PENDING_TX.has(t.state) && <Elapsed since={t.at} />}
                {t.error && <small> · {translate(t.error)}</small>}
              </td>
              <td>
                {t.txHash && (
                  <CopyValue value={t.txHash} label={translate("Copy transaction hash")} />
                )}
              </td>
              <td>
                {t.txHash && OPEN.has(t.state) && (
                  <button
                    className="ghost"
                    onClick={() => void refreshTransaction(ctx, t.id, t.txHash!).catch(() => {})}
                  >{translate("Check status")}</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
