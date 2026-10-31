/** Aztec 6 identities. A matching URL alone never establishes network identity. */
// Use the free testnet RPC's limit locally too, so rehearsals exercise the same batching.
export const V6_PROFILES = {
  local: { nodeUrl: 'http://127.0.0.1:8080', maxBatchSize: 3, nodeVersion: '6.0.0', chainId: '31337', rollupVersion: null, rollup: null, realProofs: false, sponsoredFpc: null },
  'testnet-v6': { nodeUrl: 'https://aztec-testnet.drpc.org', maxBatchSize: 3, nodeVersion: '6.0.0', chainId: '11155111', rollupVersion: '679261766', rollup: '0x1f435a7f2da358caf887a470faeee7d5d5f4efba', realProofs: true, sponsoredFpc: '0x2d8fff82a3b0c15d0a89169e7d8d043e079ab94d52031f1de1e4972ebad169d3' },
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
export type V6NodeInfo = { nodeVersion: string; l1ChainId: number | bigint; rollupVersion: number | bigint; realProofs: boolean; l1ContractAddresses: { rollupAddress: { toString(): string } } };
export function assertV6Url(network: V6Network, url: string) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Node URL must not contain credentials, query or fragment');
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid node URL protocol');
  if (network === 'local' && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('Local node URL must use loopback');
}
export function assertV6Network(network: V6Network, info: V6NodeInfo, url: string = V6_PROFILES[network].nodeUrl) {
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
      if (!['getNodeInfo', 'getContract', 'getContractClass'].includes(String(prop))) throw new Error('DRY-RUN forbidden node method');
      return value.apply(target, args);
    };
  } });
}
