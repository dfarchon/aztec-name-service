import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { RegistryReader, resolveAddress, resolvePrimary, AnsError } from '@ans/sdk/read';
import deployment from './deployment.json' with { type: 'json' };

const reader = await RegistryReader.connect(
  createAztecNodeClient(deployment.nodeUrl, { maxBatchSize: 3 }),
  AztecAddress.fromStringUnsafe(deployment.registry),
);
if (
  String(reader.deployment.chainId) !== deployment.chainId ||
  String(reader.deployment.rollupVersion) !== deployment.rollupVersion
)
  throw new AnsError('wrong_deployment', 'Unexpected testnet identity');
const name = process.argv[2] ?? 'alice';
const address = await resolveAddress(reader, name);
const primary =
  address.status === 'resolved'
    ? await resolvePrimary(reader, address.address, address.snapshot)
    : undefined;
console.log(
  JSON.stringify(
    { name, address, primary },
    (_, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  ),
);
