import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { BlockNumber, Fr } from '@aztec-labs/aztec.js/fields';
import type { RegistryReader } from './reader.js';
import type { Snapshot } from '../core/types.js';
import { AnsError, toAnsError } from '../core/errors.js';

/** Standard Token from the pinned Aztec 6.0.0 toolchain. Never infer a token by its symbol. */
export const FEE_TOKEN_CLASS_ID =
  '0x067df4ddda0b0872ef604f47f3681d5e8c0de98280ac6b79963851c055ba91e0';
export type FeeTokenMetadata = { address: AztecAddress; decimals: number; symbol: string };

export async function readFeeTokenMetadata(
  reader: RegistryReader,
  address: AztecAddress,
  snapshot?: Snapshot,
): Promise<FeeTokenMetadata> {
  try {
    const snap = snapshot ?? await reader.snapshot();
    const instance = await reader.node.getContract(address, BlockNumber(snap.blockNumber));
    if (instance?.currentContractClassId.toString() !== FEE_TOKEN_CLASS_ID)
      throw new AnsError('unsupported', 'fee asset is not the supported standard Token');
    const [precision, packedSymbol] = await Promise.all(
      [10n, 6n].map((slot) =>
        reader.node.getPublicStorageAt(BlockNumber(snap.blockNumber), address, new Fr(slot)),
      ),
    );
    const decimals = Number(precision.toBigInt());
    const symbol = new TextDecoder().decode(
      packedSymbol.toBuffer().filter((byte: number) => byte !== 0),
    );
    if (
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 255 ||
      !/^[\x21-\x7e]{1,31}$/.test(symbol)
    )
      throw new AnsError('corrupt_data', 'invalid fee asset metadata');
    return { address, decimals, symbol };
  } catch (cause) {
    const error = toAnsError(cause);
    throw error.code === 'reverted'
      ? new AnsError('network', 'cannot read fee asset metadata', cause)
      : error;
  }
}
