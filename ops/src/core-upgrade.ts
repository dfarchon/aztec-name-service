import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { readCoreUpgrade } from '@ans/sdk/read';
import type { Check } from './monitor.js';
type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;
/** Same SDK raw-slot policy as clients. All RPC calls stay at N and hash(N) is rechecked. No public simulation. */
export async function inspectCoreUpgrade(rpc: Rpc, registry: string, block: number, allowRehearsalSuccessor = false): Promise<Check> {
  try {
    const node = {
      getBlockData: (number: number) => rpc('getBlockData', [number]),
      getContract: (address: AztecAddress, number: number) => rpc('getContract', [String(address), number]),
      getPublicStorageAt: async (number: number, address: AztecAddress, slot: Fr) => new Fr(BigInt(await rpc<string>('getPublicStorageAt', [number, String(address), String(slot)]))),
    } as unknown as AztecNode;
    const header = await node.getBlockData(block as never);
    if (!header) throw new Error('missing header');
    const state = await readCoreUpgrade(node, AztecAddress.fromStringUnsafe(registry), { blockNumber: block, blockHash: String(header.blockHash), timestamp: BigInt(header.header.globalVariables.timestamp), finality: 'proposed' }, { allowRehearsalSuccessor });
    const pending = state.pending.active ? ` · proposal ready ${state.pending.readyAt}` : '';
    const scheduled = state.scheduled.active ? ` · protocol activation ${state.scheduled.activationAt}` : '';
    return { name: 'core-upgrade', ok: true, detail: `Pinned #${block} · nonce ${state.nonce}${pending}${scheduled}` };
  } catch { return { name: 'core-upgrade', ok: false, detail: 'Unknown class/edge or inconsistent application/protocol snapshot; writes must remain unavailable' }; }
}
