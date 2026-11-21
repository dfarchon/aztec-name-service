export class FeeJuiceInsufficientError extends Error {
  constructor(
    readonly account: string,
    /** The account's public Fee Juice; undefined when the wallet picked the fee payer, whose balance Fog cannot read. */
    readonly balance?: bigint,
    readonly required?: bigint,
  ) {
    super('Insufficient Fee Juice');
    this.name = 'FeeJuiceInsufficientError';
  }
}
export function feeJuiceError(
  error: unknown,
  seen = new Set<unknown>(),
): FeeJuiceInsufficientError | undefined {
  if (error instanceof FeeJuiceInsufficientError) return error;
  if (!error || typeof error !== 'object' || seen.has(error)) return;
  seen.add(error);
  return feeJuiceError((error as { cause?: unknown }).cause, seen);
}
export function insufficientFeeJuice(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const e = error as { message?: string; cause?: unknown };
  return (
    /(?:fee.?payer|fee.?juice).*(?:insufficient|balance.*(?:low|enough))|(?:insufficient|balance too low).*(?:fee|balance)/i.test(
      e.message ?? '',
    ) || insufficientFeeJuice(e.cause, seen)
  );
}
