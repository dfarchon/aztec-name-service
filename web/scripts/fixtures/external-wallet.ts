import { WalletSchema, type Wallet } from '@aztec-labs/aztec.js/wallet';
import { createSafeJsonRpcClient } from '@aztec-labs/foundation/json-rpc/client';
import { IframeConnectionHandler } from '@aztec-labs/wallet-sdk/iframe/handlers';
import { hashToEmoji } from '@aztec-labs/wallet-sdk/crypto';

// Test fixture only: no keys in the iframe or dApp. The isolated Node wallet signs and proves.
const cfg = (window as unknown as { __FOG_WALLET_TEST_CONFIG__?: {
  rpc: string; token: string; appOrigin: string; chainId: string; rollupVersion: string;
} }).__FOG_WALLET_TEST_CONFIG__;
if (!import.meta.env.DEV || !cfg || location.hostname !== '127.0.0.1') throw new Error('Local test fixture only');
const wallet = createSafeJsonRpcClient<Wallet>(cfg.rpc, WalletSchema, {
  extraHeaders: { 'x-fog-wallet-token': cfg.token },
  maxRequestBodySize: 16 * 1024 * 1024,
});
const handler = new IframeConnectionHandler({
  walletId: 'fog-isolated-test-wallet', walletName: 'Fog Test Wallet', walletVersion: '6.0.0',
  allowedOrigins: [cfg.appOrigin], logger: console,
}, {
  onPendingDiscovery: s => handler.approveDiscovery(s.requestId),
  onVerificationHash: hash => { document.querySelector('#verification')!.textContent = hashToEmoji(hash); },
  getWallet: async (appId, chain) => {
    // The encrypted wire payload contains hexadecimal strings, despite ChainInfo's in-process Fr type.
    if (appId !== 'fog-public-names' || BigInt(String(chain.chainId)).toString() !== cfg.chainId ||
      BigInt(String(chain.version)).toString() !== cfg.rollupVersion) throw new Error('Unauthorized app or chain');
    return wallet;
  },
});
handler.start();
document.body.dataset.walletReady = 'true';
