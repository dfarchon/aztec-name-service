import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash';
export const FEE_JUICE = new AztecAddress(new Fr(3));
export async function readFeeJuiceBalance(
  node: Pick<AztecNode, 'getPublicStorageAt'>,
  owner: AztecAddress,
) {
  const slot = await deriveStorageSlotInMap(new Fr(1), owner);
  return (await node.getPublicStorageAt('latest', FEE_JUICE, slot)).toBigInt();
}
export type BridgeClaim = {
  network: string;
  recipient: string;
  amount: string;
  claimSecret: string;
  claimSecretHash: string;
  messageHash?: string;
  leafIndex?: string;
  complete?: boolean;
};
export async function readBridgeClaim(
  stateDir: string,
  network: string,
  owner: string,
): Promise<BridgeClaim | undefined> {
  const path = join(stateDir, 'bridge.json');
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
      throw new Error('Fee claim file must be regular and mode 0600');
    const c = JSON.parse(await readFile(path, 'utf8')) as BridgeClaim;
    if (c.network !== network || c.recipient !== owner)
      throw new Error('Fee claim recipient/network mismatch');
    if (!c.complete || !c.messageHash || c.leafIndex === undefined) return undefined;
    return c;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
/** A claim remains reserved across ambiguous broadcasts; only its own dropped retry can reuse it. */
export function selectFeeJuice(
  balance: bigint,
  minimum: bigint,
  claim: BridgeClaim | undefined,
  state: { done: string[]; feeClaim?: { usedBy: string } },
  step: string,
) {
  if (balance >= minimum) return 'funded' as const;
  if (claim && (!state.feeClaim || (state.feeClaim.usedBy === step && !state.done.includes(step))))
    return 'claim' as const;
  throw new Error(`Deployer Fee Juice insufficient and no unconsumed claim; balance=${balance}`);
}
