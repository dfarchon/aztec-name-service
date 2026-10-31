import { translate } from "./i18n.js";
export function formatUnits(amount: bigint, decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Invalid token decimals");
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function leaseDays(expiresAt: bigint, now = Date.now()) {
  return Math.ceil((Number(expiresAt) * 1000 - now) / 86400000);
}

export function leaseText(expiresAt: bigint, now = Date.now()) {
  const days = leaseDays(expiresAt, now);
  return days <= 0 ? translate("Expired") : translate(days === 1 ? "{count} day left" : "{count} days left", { count: days });
}

export function retryDelay(failures: number) {
  return Math.min(30000, 1000 * 2 ** Math.min(5, Math.max(0, failures)));
}

/** Only hashes can be read automatically; no send/registration method belongs in the watcher. */
export const PENDING_TX = new Set(["submitted", "included", "unknown", "reorged", "proving", "simulating", "awaiting_wallet"]);
