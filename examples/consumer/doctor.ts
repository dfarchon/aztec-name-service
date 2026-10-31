import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { RegistryReader, readFeeTokenMetadata, AnsError } from '@ans/sdk/read';
import { getFeeQuote } from '@ans/sdk';
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
// A 5+ character quote shows the base price; tiered Registrars also report 3- and 4-character prices.
const quote = await getFeeQuote(reader, {
  operation: 'register',
  duration: 31536000n,
  labelLength: 5,
});
const [token, modules, administrator, sponsor] = await Promise.all([
  quote.fee ? readFeeTokenMetadata(reader, quote.feeToken, quote.snapshot) : undefined,
  reader.modular ? reader.getModules(quote.snapshot) : undefined,
  reader.getAdministrator(quote.snapshot),
  reader.node.getContract(AztecAddress.fromStringUnsafe(deployment.sponsoredFpc)),
]);
if (
  sponsor?.currentContractClassId.toString() !==
  '0x233391319da4f9877f724afd66d93a2d0dbb4a288f41e99093dbb30f41ee3335'
)
  throw new AnsError('wrong_deployment', 'Unexpected sponsor contract class');
console.log(
  JSON.stringify(
    {
      network: reader.deployment,
      registryClass: reader.classId,
      quote,
      lengthPrices: quote.lengthPrices,
      paymentAsset: token,
      modules,
      administrator,
      sponsor: 'verified',
      funding: {
        selfServeFaucet: false,
        requiredToken: quote.feeToken.toString(),
        instruction:
          'Obtain private test-token balance from the testnet operator for your authorized account. Fee Juice cannot pay this fee.',
      },
      next: 'npm run dev, connect a compatible wallet, verify symbols, select an account and check private payment readiness',
    },
    (_, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  ),
);
