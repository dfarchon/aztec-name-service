import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { RegistryReader, readFeeTokenMetadata, FogError } from 'fog-sdk/read';
import { getFeeQuote } from 'fog-sdk';
import deployment from './deployment.json' with { type: 'json' };

const reader = await RegistryReader.connect(
  createAztecNodeClient(deployment.nodeUrl, { maxBatchSize: 3 }),
  AztecAddress.fromStringUnsafe(deployment.registry),
);
if (
  String(reader.deployment.chainId) !== deployment.chainId ||
  String(reader.deployment.rollupVersion) !== deployment.rollupVersion
)
  throw new FogError('wrong_deployment', 'Unexpected deployment identity');
// A 5+ character quote shows the base price; tiered Registrars also report 3- and 4-character prices.
const quote = await getFeeQuote(reader, {
  operation: 'register',
  duration: 31536000n,
  labelLength: 5,
});
const sponsoredFpc = (deployment as { sponsoredFpc?: string | null }).sponsoredFpc;
const [token, modules, administrator, sponsor] = await Promise.all([
  quote.fee ? readFeeTokenMetadata(reader, quote.feeToken, quote.snapshot) : undefined,
  reader.modular ? reader.getModules(quote.snapshot) : undefined,
  reader.getAdministrator(quote.snapshot),
  sponsoredFpc ? reader.node.getContract(AztecAddress.fromStringUnsafe(sponsoredFpc)) : undefined,
]);
if (
  sponsoredFpc &&
  sponsor?.currentContractClassId.toString() !==
    '0x233391319da4f9877f724afd66d93a2d0dbb4a288f41e99093dbb30f41ee3335'
)
  throw new FogError('wrong_deployment', 'Unexpected sponsor contract class');
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
      sponsor: sponsoredFpc ? 'verified' : 'fee-juice (account-paid)',
      funding:
        quote.fee === 0n
          ? {
              selfServeFaucet: false,
              requiredToken: quote.feeToken.toString(),
              instruction: sponsoredFpc
                ? 'Registration fee is zero and network gas is sponsored.'
                : 'Registration fee is zero; fund your Aztec account with public Fee Juice for L2 network gas.',
            }
          : {
              selfServeFaucet: false,
              requiredToken: quote.feeToken.toString(),
              instruction:
                'Obtain private balance in the quoted token for your authorized account. Fee Juice pays network gas only.',
            },
      next: 'npm run dev, connect a compatible wallet, verify symbols, select an account and check payment readiness',
    },
    (_, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  ),
);
