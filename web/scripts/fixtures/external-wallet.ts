import { WalletSchema, type Wallet } from '@aztec-labs/aztec.js/wallet';
import { createSafeJsonRpcClient } from '@aztec-labs/foundation/json-rpc/client';
import { IframeConnectionHandler } from '@aztec-labs/wallet-sdk/iframe/handlers';
import { hashToEmoji } from '@aztec-labs/wallet-sdk/crypto';

// Test fixture only: no keys in the iframe or dApp. The isolated Node wallet signs and proves.
const cfg = (window as unknown as { __ANS_WALLET_TEST_CONFIG__?: {
  rpc: string; token: string; appOrigin: string; chainId: string; rollupVersion: string;
} }).__ANS_WALLET_TEST_CONFIG__;
if (!import.meta.env.DEV || !cfg || location.hostname !== '127.0.0.1') throw new Error('Local test fixture only');
const wallet = createSafeJsonRpcClient<Wallet>(cfg.rpc, WalletSchema, { extraHeaders: { 'x-ans-wallet-token': cfg.token } });
const handler = new IframeConnectionHandler({
  walletId: 'ans-isolated-test-wallet', walletName: 'ANS Test Wallet', walletVersion: '5.2.1',
  allowedOrigins: [cfg.appOrigin], logger: console,
}, {
  onPendingDiscovery: s => handler.approveDiscovery(s.requestId),
  onVerificationHash: hash => { document.querySelector('#verification')!.textContent = hashToEmoji(hash); },
  getWallet: async (appId, chain) => {
    // The encrypted wire payload contains hexadecimal strings, despite ChainInfo's in-process Fr type.
    if (appId !== 'ans-public-names' || BigInt(String(chain.chainId)).toString() !== cfg.chainId ||
      BigInt(String(chain.version)).toString() !== cfg.rollupVersion) throw new Error('Unauthorized app or chain');
    return wallet;
  },
});
handler.start();
document.body.dataset.walletReady = 'true';
