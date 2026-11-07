export function parseNetworkConfig(env: {
  DEV?: boolean;
  VITE_NETWORK?: string;
  VITE_FEE_PAYMENT?: string;
}) {
  const network = env.VITE_NETWORK ?? (env.DEV ? 'local' : undefined);
  if (!network || !['local', 'testnet-v6', 'mainnet'].includes(network))
    throw new Error('VITE_NETWORK must be local|testnet-v6|mainnet');
  const feePayment =
    env.VITE_FEE_PAYMENT ?? (env.DEV || network === 'local' ? 'sponsored' : undefined);
  if (!feePayment || !['sponsored', 'fee-juice'].includes(feePayment))
    throw new Error('VITE_FEE_PAYMENT must be sponsored|fee-juice');
  if (network === 'mainnet' && feePayment !== 'fee-juice')
    throw new Error('Mainnet requires fee-juice');
  return {
    network: network as 'local' | 'testnet-v6' | 'mainnet',
    feePayment: feePayment as 'sponsored' | 'fee-juice',
  };
}
/** Derivation is allowed only on the proof-disabled local identity. */
export function canDeriveSponsor(info: { l1ChainId: number | bigint; realProofs: boolean }) {
  return String(info.l1ChainId) === '31337' && !info.realProofs;
}

type Network = ReturnType<typeof parseNetworkConfig>['network'];
type Identity = { chainId: string | number | bigint; rollupVersion: string | number | bigint };

// Pinned to the selected Aztec 6 profiles; tests compare these to deployment validation.
const publicIdentity = {
  'testnet-v6': { chainId: '11155111', rollupVersion: '679261766' },
  mainnet: { chainId: '1', rollupVersion: '2070860440' },
} as const;

export function parseRpcConfig(env: {
  DEV?: boolean;
  VITE_NETWORK?: string;
  VITE_NODE_URL?: string;
  VITE_CHAIN_ID?: string;
  VITE_ROLLUP_VERSION?: string;
}, network: Network) {
  const local = network === 'local';
  const endpoint = env.VITE_NODE_URL ?? (local ? 'http://localhost:8080' : undefined);
  if (!endpoint || /[,\s]/.test(endpoint))
    throw new Error('VITE_NODE_URL must contain exactly one RPC URL');
  const url = new URL(endpoint);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const publicFixture = env.DEV === true && env.VITE_NETWORK === network && loopback;
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || publicFixture))))
    throw new Error('Public RPC requires HTTPS (explicit DEV loopback fixtures excepted)');
  const chainId = env.VITE_CHAIN_ID || (local ? '31337' : undefined);
  const rollupVersion = env.VITE_ROLLUP_VERSION || undefined;
  if (!chainId || !/^[1-9][0-9]*$/.test(chainId) ||
      (rollupVersion !== undefined && !/^[0-9]+$/.test(rollupVersion)) ||
      (!local && !rollupVersion))
    throw new Error('VITE_CHAIN_ID and VITE_ROLLUP_VERSION must pin the network identity');
  if (local ? chainId !== '31337' : identityMismatch(publicIdentity[network], undefined, {
    chainId, rollupVersion: rollupVersion!,
  })) throw new Error('RPC identity does not match the selected VITE_NETWORK profile');
  // One endpoint today. Future candidates must pass this same network/identity check before use.
  // Switch only reads; sendTx goes once to the active endpoint. Afterwards track only its known
  // hash, optionally on another verified same-network candidate. Never fall back across networks.
  return {
    endpoints: Object.freeze([endpoint] as const),
    expectedChainId: chainId,
    expectedRollupVersion: rollupVersion,
  };
}

export function identityMismatch(
  expected: { chainId?: string; rollupVersion?: string },
  previous: Identity | undefined,
  current: Identity,
) {
  return (expected.chainId !== undefined && expected.chainId !== String(current.chainId)) ||
    (expected.rollupVersion !== undefined && expected.rollupVersion !== String(current.rollupVersion)) ||
    (previous !== undefined && (String(previous.chainId) !== String(current.chainId) ||
      String(previous.rollupVersion) !== String(current.rollupVersion)));
}
