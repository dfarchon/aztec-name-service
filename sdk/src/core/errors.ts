export type AnsErrorCode =
  | "invalid_name"
  | "invalid_argument"
  | "wrong_deployment"
  | "network"
  | "not_holder"
  | "not_administrator"
  | "not_active"
  | "name_taken"
  | "name_reserved"
  | "name_not_available_yet"
  | "registration_paused"
  | "migration_required"
  | "conflict"
  | "commit_not_ready"
  | "commit_expired"
  | "commit_missing"
  | "fee_changed"
  | "quote_expired"
  | "forward_mismatch"
  | "wallet_rejected"
  | "unsupported"
  | "reverted"
  | "dropped"
  | "unknown_tx_state"
  | "corrupt_data";

/** Every SDK failure carries a stable code; UIs branch on the code, never on message text. */
export class AnsError extends Error {
  constructor(
    public readonly code: AnsErrorCode,
    message: string,
    public readonly cause?: unknown,
    /** Set when a transaction was already sent: callers resume tracking it instead of resending. */
    public readonly txHash?: string,
  ) {
    super(message);
    this.name = "AnsError";
  }
}

/** Contract assertion messages (see main.nr / logic.nr) and the code each one maps to. */
const CONTRACT_MESSAGES: [string, AnsErrorCode][] = [
  ["generation or revision mismatch", "conflict"],
  ["not record editor", "not_holder"],
  ["parent not active", "not_active"],
  ["not transfer recipient", "invalid_argument"],
  ["transfer offer expired", "invalid_argument"],
  ["record key limit reached", "invalid_argument"],
  ["subname depth exceeded", "invalid_name"],
  ["invalid subname expiry", "invalid_argument"],
  ["subname lease is controlled by parent", "invalid_argument"],
  ["unauthorized registrar", "fee_changed"],
  ["unauthorized resolver", "conflict"],
  ["resolver not approved", "unsupported"],
  ["legacy name reserved", "migration_required"],
  ["not legacy holder", "not_holder"],
  ["name already initialized", "conflict"],
  ["not administrator", "not_administrator"],
  ["module belongs to another registry", "wrong_deployment"],
  ["generation mismatch", "conflict"],
  ["revision mismatch", "conflict"],
  ["binding version mismatch", "conflict"],
  ["not the holder", "not_holder"],
  ["name not active", "not_active"],
  ["name not renewable", "not_active"],
  ["name not yet available", "name_not_available_yet"],
  ["name reserved", "name_reserved"],
  ["registration paused", "registration_paused"],
  ["lease must be one year", "invalid_argument"],
  ["renewal too early", "invalid_argument"],
  ["name not available", "name_taken"],
  ["commitment too young", "commit_not_ready"],
  ["commitment expired", "commit_expired"],
  ["unknown commitment", "commit_missing"],
  ["commitment already consumed", "commit_missing"],
  ["fee exceeds max_fee", "fee_changed"],
  ["fee quote expired", "quote_expired"],
  ["forward record does not point to caller", "forward_mismatch"],
  ["invalid label", "invalid_name"],
  ["label cannot start or end with hyphen", "invalid_name"],
  ["label padding must be zero", "invalid_name"],
  ["label cannot contain --", "invalid_name"],
  ["label cannot start with 0x", "invalid_name"],
  ["invalid duration", "invalid_argument"],
  ["deadline", "invalid_argument"],
];

const NETWORK_PATTERNS = [
  /fetch failed/i,
  /failed to fetch/i,
  /network request failed/i,
  /networkerror/i,
  /(?:request|connection|rpc|fetch).*(?:timed?\s*out|timeout)/i,
  /load failed/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /network ?error/i,
  /socket hang up/i,
];
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"]);
function isTransportFailure(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || seen.has(error)) return false;
  seen.add(error);
  if (typeof error === "string") return NETWORK_PATTERNS.some(p => p.test(error));
  if (typeof error !== "object") return false;
  const value = error as { message?: unknown; name?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
  return NETWORK_CODES.has(String(value.code)) || value.name === "TimeoutError" ||
    (typeof value.message === "string" && NETWORK_PATTERNS.some(p => p.test(value.message as string))) ||
    isTransportFailure(value.cause, seen) ||
    (Array.isArray(value.errors) && value.errors.some(e => isTransportFailure(e, seen)));
}
const REJECT_PATTERNS = [
  /user rejected/i,
  /user denied/i,
  /request rejected/i,
  /cancelled by user/i,
];

/** Maps any thrown value (contract revert, transport failure, wallet rejection) to an AnsError. */
export function toAnsError(e: unknown): AnsError {
  if (e instanceof AnsError) return e;
  const message = e instanceof Error ? e.message : String(e);
  for (const [needle, code] of CONTRACT_MESSAGES) {
    if (message.includes(needle)) return new AnsError(code, needle, e);
  }
  if (REJECT_PATTERNS.some((p) => p.test(message)))
    return new AnsError("wallet_rejected", "rejected in wallet", e);
  if (isTransportFailure(e))
    return new AnsError("network", "node unreachable", e);
  return new AnsError("reverted", message.split("\n")[0].slice(0, 200), e);
}
