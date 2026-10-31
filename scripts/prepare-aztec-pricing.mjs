import { readFileSync, writeFileSync } from 'node:fs';
import { RegistryReader } from '@ans/sdk/read';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { BlockNumber, Fr } from '@aztec-labs/aztec.js/fields';
import { createAztecPricingPlan, validateAztecPricing } from './aztec-pricing.mjs';

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output'))
  throw new Error('Usage: npm run prepare:aztec-pricing -- [--output /path/to/public-report.json]');
const policy = validateAztecPricing(JSON.parse(readFileSync('deployments/aztec-pricing.json', 'utf8')));
const deployment = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const node = createAztecNodeClient(deployment.nodeUrl);
const reader = await RegistryReader.connect(node, AztecAddress.fromStringUnsafe(deployment.registry));
if (String(reader.deployment.chainId) !== deployment.chainId || String(reader.deployment.rollupVersion) !== deployment.rollupVersion)
  throw new Error('Network identity changed; review the deployment before preparing a fee policy');
const snapshot = await reader.snapshot('finalized');
const active = await reader.getConfig(snapshot);
if (!active.registrar) throw new Error('A Registrar is required for this deployment report');
const metadata = JSON.parse(readFileSync('web/src/public-metadata.json', 'utf8'));
const instance = await node.getContract(active.feeToken);
if (!instance?.currentContractClassId.equals(Fr.fromString(metadata.tokenClassId)))
  throw new Error('Active fee token is not the verified standard Token class');
const [d, s] = await Promise.all([metadata.tokenDecimalsSlot, metadata.tokenSymbolSlot].map(slot =>
  node.getPublicStorageAt(BlockNumber(snapshot.blockNumber), active.feeToken, Fr.fromString(slot))));
if (!await reader.isCanonical(snapshot)) throw new Error('Fee snapshot is no longer canonical; retry the read');
const report = {
  checkedAt: new Date().toISOString(),
  snapshot: { ...snapshot, timestamp: String(snapshot.timestamp) },
  ...createAztecPricingPlan(policy, {
    nodeUrl: deployment.nodeUrl, chainId: deployment.chainId, rollupVersion: deployment.rollupVersion,
    registry: reader.registry.toString(), registrar: active.registrar.toString(),
    feeToken: active.feeToken.toString(), treasury: active.treasury.toString(),
    annualPrice: String(active.annualPrice), priceVersion: active.priceVersion,
    symbol: new TextDecoder().decode(s.toBuffer().filter(b => b !== 0)), decimals: Number(d.toBigInt()),
  }),
};
const json = JSON.stringify(report, null, 2) + '\n';
if (args[1]) writeFileSync(args[1], json);
process.stdout.write(json);
