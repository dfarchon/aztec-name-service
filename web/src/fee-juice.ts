import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import { deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash';
import { Gas, GasSettings } from '@aztec-labs/stdlib/gas';
import { FeeJuiceInsufficientError, insufficientFeeJuice } from './fee-juice-error';
export { FeeJuiceInsufficientError } from './fee-juice-error';
export async function readFeeJuiceBalance(
  node: Pick<AztecNode, 'getPublicStorageAt'>,
  account: AztecAddress,
) {
  const slot = await deriveStorageSlotInMap(new Fr(1), account);
  return (await node.getPublicStorageAt('latest', new AztecAddress(new Fr(3)), slot)).toBigInt();
}
/** Conservative admission budget, in wei: current minimum prices × node-advertised default gas limits. */
export async function assertFeeJuice(node: AztecNode, account: AztecAddress) {
  const [balance, fees, info] = await Promise.all([
    readFeeJuiceBalance(node, account),
    node.getCurrentMinFees(),
    node.getNodeInfo(),
  ]);
  const required = GasSettings.fallback({
    gasLimits: Gas.from(info.txsLimits.gas),
    maxFeesPerGas: fees,
  })
    .getFeeLimit()
    .toBigInt();
  if (balance === 0n || balance < required)
    throw new FeeJuiceInsufficientError(account.toString(), balance, required);
}
const guards = new WeakMap<Wallet, Wallet>();
/** One wrapper per wallet preserves SDK queue sharing across accounts. */
export function feeJuiceWallet(wallet: Wallet, node: AztecNode): Wallet {
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
                await readFeeJuiceBalance(node, from),
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
