import { feeJuiceError } from "./fee-juice-error.js";
import { dateLocale, translate } from "./i18n.js";
import {
  type AnsError,
  type NameStatus,
  toAnsError,
  type TxState,
} from "@ans/sdk/read";
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";

export const shortAddr = (a: AztecAddress | string) => {
  const s = a.toString();
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
};

export const date = (seconds: bigint) =>
  new Date(Number(seconds) * 1000).toLocaleString(dateLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  });

export const duration = (seconds: bigint) => {
  const s = Number(seconds);
  if (s < 60) return translate("{count} s", { count: s });
  if (s < 3600) return translate("{count} min", { count: Math.ceil(s / 60) });
  return translate("{count} h", { count: (s / 3600).toFixed(1) });
};

export const statusText: Record<NameStatus, string> = {
  unregistered: "Unregistered",
  active: "Active",
  grace: "Expired · Renewable",
  released: "Available to register again",
};

export const txStateText: Record<TxState, string> = {
  awaiting_wallet: "Awaiting wallet approval",
  simulating: "Simulating transaction",
  proving: "Waiting for wallet confirmation and proof",
  submitted: "Submitted · Awaiting inclusion",
  included: "Included · Awaiting confirmation",
  confirmed: "Confirmed",
  proven: "Proven",
  cancelled: "Cancelled",
  reverted: "Reverted",
  dropped: "Dropped by network",
  reorged: "Chain reorg · Syncing",
  unknown: "Status unknown. Check again shortly.",
};

const errorText: Partial<Record<AnsError["code"], string>> = {
  invalid_name: "Invalid name format",
  network: "Unable to read the network. Try again.",
  not_administrator: "This account cannot configure the registry.",
  not_holder: "This account does not own the name.",
  not_active: "This name is not active.",
  migration_required: "The previous owner must migrate this name.",
  name_taken: "This name is already registered.",
  name_reserved: "Reserved",
  name_not_available_yet: "Not yet available",
  renewal_too_early: "Renewal is not available yet. Refresh the name to see when it becomes renewable.",
  registration_paused: "Public registration is paused. Renewals remain available to holders.",
  conflict: "On-chain state changed. Refresh and retry.",
  commit_not_ready: "Wait for the registration countdown to finish.",
  commit_expired: "Registration request expired. Start again.",
  commit_missing: "Registration request not found. Check the commit status.",
  fee_changed: "Fee terms changed. Review and confirm again.",
  quote_expired: "Quote expired. Start again.",
  forward_mismatch: "This name does not resolve to the current account.",
  wallet_rejected: "Cancelled in wallet. No service fee was charged.",
  unsupported: "This wallet does not support this action.",
  reverted: "Transaction reverted. The service fee was reverted; network fees already incurred are not refunded.",
  dropped: "Transaction dropped. You can safely retry.",
  unknown_tx_state: "Transaction status is unknown. Check your activity before paying again.",
  wrong_deployment: "Deployment mismatch",
};

export function errorMessage(e: unknown): string {
  const feeError = feeJuiceError(e);
  if (feeError) return translate("Insufficient Fee Juice for {account}. Balance: {balance} wei. Bridge Fee Juice from L1; it is not the registration token.", { account: feeError.account, balance: String(feeError.balance) });
  if (e instanceof Error && /^(Cannot (read|save)|Wallet account changed|Another tab)/.test(e.message))
    return e.message;
  const err = toAnsError(e);
  // Wallet setup and client exceptions are not evidence that a transaction executed or charged a fee.
  if (err.code === "reverted" && (!(e instanceof Error) || e.name !== "AnsError"))
    return "The action did not complete. If you have a transaction hash, check its status before retrying.";
  return errorText[err.code] ?? err.message;
}
