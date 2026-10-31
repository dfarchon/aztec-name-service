import { AztecAddress } from "@aztec-labs/aztec.js/addresses";

const env = import.meta.env;

export const config = {
  nodeUrl: (env.VITE_NODE_URL as string | undefined) || "http://localhost:8080",
  registry: env.VITE_REGISTRY
    ? AztecAddress.fromStringUnsafe(env.VITE_REGISTRY as string)
    : undefined,
  nameSuffix: (env.VITE_NAME_SUFFIX as string | undefined) || undefined,
  webWalletUrls: ((env.VITE_WEB_WALLET_URLS as string | undefined) || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  developmentWallet: env.DEV && env.VITE_DEVELOPMENT_WALLET === "true",
  proverEnabled: env.VITE_PROVER_ENABLED === "true",
  expectedChainId: env.VITE_CHAIN_ID as string | undefined,
  expectedRollupVersion: env.VITE_ROLLUP_VERSION as string | undefined,
  release: (env.VITE_RELEASE as string | undefined) || "local",
  sponsoredFpc: env.VITE_SPONSORED_FPC
    ? AztecAddress.fromStringUnsafe(env.VITE_SPONSORED_FPC as string)
    : undefined,
};
