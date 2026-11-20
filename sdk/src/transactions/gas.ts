import { MAX_PROCESSABLE_L2_GAS, MAX_TX_DA_GAS } from '@aztec-labs/constants';
import { Gas } from '@aztec-labs/stdlib/gas';

import { FogError } from '../core/errors.js';

/** Declared gas limits for one transaction, derived from a simulation of exactly that call. */
export type GasEstimate = { gasLimits: Gas; teardownGasLimits: Gas };

/** Same margin Aztec wallets apply to a simulated estimate. */
export const GAS_ESTIMATE_PADDING = 0.1;

type GasLike = { daGas: number; l2Gas: number };

/**
 * Pads simulated usage and caps it at the network's per-transaction admission limit (the node's
 * `txsLimits.gas`, itself capped at the protocol maxima). Without explicit limits a wallet declares that whole
 * admission limit, and the fee payer must hold the matching maximum fee even though actual usage is far lower.
 */
export function paddedGasLimits(
  used: { totalGas: GasLike; teardownGas: GasLike },
  maxTxGas: GasLike,
  pad = GAS_ESTIMATE_PADDING,
): GasEstimate {
  const cap = new Gas(Math.min(maxTxGas.daGas, MAX_TX_DA_GAS), Math.min(maxTxGas.l2Gas, MAX_PROCESSABLE_L2_GAS));
  if (used.totalGas.daGas > cap.daGas || used.totalGas.l2Gas > cap.l2Gas)
    throw new FogError('unsupported', 'transaction needs more gas than the network admits per transaction');
  // Integer percent arithmetic: 200000 * 1.1 in floating point rounds up to 220001.
  const percent = 100 + Math.round(pad * 100);
  const scale = (value: number) => Math.ceil((value * percent) / 100);
  const padded = (gas: GasLike) =>
    new Gas(Math.min(scale(gas.daGas), cap.daGas), Math.min(scale(gas.l2Gas), cap.l2Gas));
  return { gasLimits: padded(used.totalGas), teardownGasLimits: padded(used.teardownGas) };
}
