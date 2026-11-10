import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { WalletManager, type WalletProvider } from '@aztec-labs/wallet-sdk/manager';
import { hashToEmoji } from '@aztec-labs/wallet-sdk/crypto';
import type { RegistryReader } from '@ans/sdk/read';
import deployment from './deployment.json' with { type: 'json' };

/** Browser host renders providers and cancels the returned discovery on unmount. */
export function discoverWallets(
  appId: string,
  onWalletDiscovered: (provider: WalletProvider) => void,
) {
  return WalletManager.configure({ extensions: { enabled: true } }).getAvailableWallets({
    appId,
    timeout: 15000,
    onWalletDiscovered,
    chainInfo: {
      chainId: new Fr(BigInt(deployment.chainId)),
      version: new Fr(BigInt(deployment.rollupVersion)),
    },
  });
}

/**
 * verify must show the symbols and return the user's actual comparison/approval.
 * Aztec 6 wallets then ask the user to grant ANS its accounts and contracts; use the returned wallet afterwards.
 */
export async function connectWallet(
  reader: RegistryReader,
  provider: WalletProvider,
  appId: string,
  verify: (symbols: string) => Promise<boolean>,
  container?: HTMLElement,
) {
  const pending = await provider.establishSecureChannel(
    appId,
    container ? { container } : undefined,
  );
  try {
    if (!(await verify(hashToEmoji(pending.verificationHash)))) {
      pending.cancel();
      return undefined;
    }
    const wallet = await pending.confirm();
    const { requestAnsCapabilities } = await import('@ans/sdk');
    return await requestAnsCapabilities(reader, wallet, {
      app: { name: appId, version: '1.0.0', url: location.origin },
      sponsoredFpc: AztecAddress.fromStringUnsafe(deployment.sponsoredFpc),
    });
  } catch (error) {
    pending.cancel();
    throw error;
  }
}
