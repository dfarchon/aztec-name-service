/** Aztec 6 identities. A matching URL alone never establishes network identity. */
// Use the free testnet RPC's limit locally too, so rehearsals exercise the same batching.
export const V6_PROFILES = {
  local: { nodeUrl: 'http://127.0.0.1:8080', maxBatchSize: 3, nodeVersion: '6.0.0', chainId: '31337', rollupVersion: null, rollup: null, realProofs: false, sponsoredFpc: null, feePayment: 'sponsored', feeJuicePortal: null, feeAssetHandler: null, l1FeeJuice: null },
  'testnet-v6': { nodeUrl: 'https://aztec-testnet.drpc.org', maxBatchSize: 3, nodeVersion: '6.0.0', chainId: '11155111', rollupVersion: '679261766', rollup: '0x1f435a7f2da358caf887a470faeee7d5d5f4efba', realProofs: true, sponsoredFpc: '0x2d8fff82a3b0c15d0a89169e7d8d043e079ab94d52031f1de1e4972ebad169d3', feePayment: 'sponsored', feeJuicePortal: '0xe59acba462a0324b1d619a7a1b219419f156f505', feeAssetHandler: '0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9', l1FeeJuice: null },
  mainnet: { nodeUrl: null, maxBatchSize: 3, nodeVersion: '6.0.0', chainId: '1', rollupVersion: '2070860440', rollup: '0xe37a2663cc9c119ba41572c40fab0bbb23a5402f', realProofs: true, sponsoredFpc: null, feePayment: 'fee-juice', feeJuicePortal: '0x534361be805ca30bdb6404ec5e6cdaffb3e9f3b3', feeAssetHandler: null, l1FeeJuice: '0xa27ec0006e59f245217ff08cd52a7e8b169e62d2' },
} as const;
export type V6Network = keyof typeof V6_PROFILES;
type FpcIdentity = { address: { toString(): string }; currentContractClassId: { toString(): string } };
/** Local fee payment can register the derived instance before its first publication. */
export function assertV6Fpc(network: V6Network, derived: FpcIdentity, artifactClass: string, published?: FpcIdentity) {
  if (derived.currentContractClassId.toString() !== artifactClass) throw new Error('SponsoredFPC derived class mismatch');
  const pinned = V6_PROFILES[network].sponsoredFpc;
  if (pinned && derived.address.toString() !== pinned) throw new Error('SponsoredFPC address mismatch');
  if (!published) {
    if (network !== 'local') throw new Error('SponsoredFPC is not published');
    return 'derived-not-published';
  }
  if (published.address.toString() !== derived.address.toString() || published.currentContractClassId.toString() !== artifactClass) throw new Error('SponsoredFPC published identity mismatch');
  return 'published';
}
export type V6NodeInfo = { nodeVersion: string; l1ChainId: number | bigint; rollupVersion: number | bigint; realProofs: boolean; l1ContractAddresses: { rollupAddress: { toString(): string }; feeJuicePortalAddress?: { toString(): string }; feeAssetHandlerAddress?: { toString(): string }; feeJuiceAddress?: { toString(): string } } };
export function assertV6Url(network: V6Network, url: string) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Node URL must not contain credentials, query or fragment');
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid node URL protocol');
  if (network === 'local' && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('Local node URL must use loopback');
}
export function assertV6Network(network: V6Network, info: V6NodeInfo, url: string = V6_PROFILES[network].nodeUrl ?? '') {
  assertV6Url(network, url);
  const p = V6_PROFILES[network];
  const actual = { nodeVersion: info.nodeVersion, chainId: String(info.l1ChainId), rollupVersion: String(info.rollupVersion), rollup: info.l1ContractAddresses.rollupAddress.toString().toLowerCase(), realProofs: info.realProofs };
  for (const key of ['nodeVersion', 'chainId', 'rollupVersion', 'rollup', 'realProofs'] as const)
    if (p[key] !== null && p[key] !== actual[key]) throw new Error(`V6 network identity mismatch: ${key}`);
  return { chainId: actual.chainId, rollupVersion: actual.rollupVersion, rollup: actual.rollup };
}
/** A dry run cannot acquire wallet data through the node or broadcast indirectly. */
export function dryRunNode<T extends object>(node: T, used: Set<string>): T {
  return new Proxy(node, { get(target, prop) {
    const value = Reflect.get(target, prop);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      used.add(String(prop));
      if (!['getNodeInfo', 'getContract', 'getContractClass', 'getPublicStorageAt'].includes(String(prop))) throw new Error('DRY-RUN forbidden node method');
      return value.apply(target, args);
    };
  } });
}

export function assertV6FeeJuice(network: V6Network, info: V6NodeInfo) {
  const p = V6_PROFILES[network], a = info.l1ContractAddresses;
  for (const [key, actual] of [['feeJuicePortal', a.feeJuicePortalAddress], ['feeAssetHandler', a.feeAssetHandlerAddress], ['l1FeeJuice', a.feeJuiceAddress]] as const) {
    if (p[key] && actual?.toString().toLowerCase() !== p[key]) throw new Error(`Fee Juice identity mismatch: ${key}`);
  }
  if (!a.feeJuicePortalAddress) throw new Error('Fee Juice portal missing');
}
