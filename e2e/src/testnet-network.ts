/** Pin network identity before opening a wallet or broadcasting. Docs can lag behind the live network. */
export function assertStateToolchain(state: { toolchainVersion?: unknown }) {
  if (state.toolchainVersion !== '5.2.1')
    throw new Error('Saved state uses another toolchain; keep legacy state and choose a new private directory');
}

export function assertTestnet(url: string, info: {
  nodeVersion: string; l1ChainId: number; rollupVersion: number; realProofs: boolean;
  l1ContractAddresses: { rollupAddress: { toString(): string } };
}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'v5.testnet.rpc.aztec-labs.com' || endpoint.username || endpoint.password)
    throw new Error('Use the official HTTPS v5 testnet RPC');
  if (info.l1ChainId !== 11155111 || info.rollupVersion !== 1821665230 ||
    info.l1ContractAddresses.rollupAddress.toString().toLowerCase() !== '0xd73a91bdcf6891c7642f3e460036e1ef2cc23178')
    throw new Error('Testnet identity changed; review network configuration before sending');
  // The live endpoint currently self-reports 5.0.0. Allow only that observed runtime or the pinned 5.2.1 upgrade; chain identity and FPC class are also verified.
  if (!['5.0.0', '5.2.1'].includes(info.nodeVersion) || info.realProofs !== true)
    throw new Error('Testnet requires a verified 5.0.0 / 5.2.1 runtime and real proofs');
}
