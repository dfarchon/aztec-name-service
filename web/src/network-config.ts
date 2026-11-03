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
