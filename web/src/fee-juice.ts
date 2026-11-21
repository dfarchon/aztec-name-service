import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import { deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash';
import { Gas, GasFees, GasSettings } from '@aztec-labs/stdlib/gas';
import { FeeJuiceInsufficientError, insufficientFeeJuice } from './fee-juice-error';
export { FeeJuiceInsufficientError } from './fee-juice-error';
export async function readFeeJuiceBalance(
  node: Pick<AztecNode, 'getPublicStorageAt'>,
  account: AztecAddress,
) {
  const slot = await deriveStorageSlotInMap(new Fr(1), account);
  return (await node.getPublicStorageAt('latest', new AztecAddress(new Fr(3)), slot)).toBigInt();
}
/** Wallet default: the worst predicted minimum fee per gas, plus 50%. */
const FEE_PADDING_PERCENT = 150n;
/**
 * Maximum fee the transaction declares, which the node requires the fee payer to hold: declared gas limits
 * times the wallet's padded max fee per gas. With an estimate the limits are the simulated usage plus 10%;
 * without one the wallet declares the node's whole per-transaction limit, which is far larger.
 */
export async function requiredFeeJuice(
  node: Pick<AztecNode, 'getCurrentMinFees' | 'getNodeInfo'> & Partial<Pick<AztecNode, 'getPredictedMinFees'>>,
  gasLimits?: Gas,
) {
  const [fees, limits] = await Promise.all([
    worstMinFees(node),
    gasLimits ?? node.getNodeInfo().then((info) => Gas.from(info.txsLimits.gas)),
  ]);
  const maxFeesPerGas = new GasFees(
    (fees.feePerDaGas * FEE_PADDING_PERCENT) / 100n,
    (fees.feePerL2Gas * FEE_PADDING_PERCENT) / 100n,
  );
  return GasSettings.fallback({ gasLimits: limits, maxFeesPerGas }).getFeeLimit().toBigInt();
}
async function worstMinFees(
  node: Pick<AztecNode, 'getCurrentMinFees'> & Partial<Pick<AztecNode, 'getPredictedMinFees'>>,
) {
  try {
    const predicted = (await node.getPredictedMinFees?.()) ?? [];
    if (predicted.length)
      return predicted.reduce((worst, fees) => (fees.feePerL2Gas > worst.feePerL2Gas ? fees : worst));
  } catch {
    /* Older nodes have no fee prediction; the current minimum is the fallback, as in the wallet. */
  }
  return node.getCurrentMinFees();
}
/** Fast check before simulating: an empty account can never pay a network fee. */
export async function assertFeeJuiceFunded(
  node: Pick<AztecNode, 'getPublicStorageAt'>,
  account: AztecAddress,
) {
  const balance = await readFeeJuiceBalance(node, account);
  if (balance === 0n) throw new FeeJuiceInsufficientError(account.toString(), balance);
}
/** The balance must cover the transaction's declared maximum fee, or the node rejects it after proving. */
export async function assertFeeJuice(node: AztecNode, account: AztecAddress, gasLimits?: Gas) {
  const [balance, required] = await Promise.all([
    readFeeJuiceBalance(node, account),
    requiredFeeJuice(node, gasLimits),
  ]);
  if (balance === 0n || balance < required)
    throw new FeeJuiceInsufficientError(account.toString(), balance, required);
}
const guards = new WeakMap<Wallet, Wallet>();
/**
 * One wrapper per wallet preserves SDK queue sharing across accounts. With `walletPicksPayer` the wallet chose
 * the fee payer (for example private Fee Juice through its fee payment contract), so the account's public
 * balance is not reported as the shortfall.
 */
export function feeJuiceWallet(
  wallet: Wallet,
  node: AztecNode,
  { walletPicksPayer = false }: { walletPicksPayer?: boolean } = {},
): Wallet {
  const existing = guards.get(wallet);
  if (existing) return existing;
  const guarded = new Proxy(wallet, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === 'sendTx')
        return async (...args: unknown[]) => {
          try {
            return await value.apply(target, args);
          } catch (e) {
            const from = (args[1] as { from?: AztecAddress })?.from;
            if (from && insufficientFeeJuice(e))
              throw new FeeJuiceInsufficientError(
                from.toString(),
                walletPicksPayer ? undefined : await readFeeJuiceBalance(node, from),
              );
            throw e;
          }
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  guards.set(wallet, guarded);
  return guarded;
}
