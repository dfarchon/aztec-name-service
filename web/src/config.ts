import { AztecAddress } from "@aztec-labs/aztec.js/addresses";

import { parseNetworkConfig, parseRpcConfig } from "./network-config";

const env = import.meta.env;
const network = parseNetworkConfig(env);
const rpc = parseRpcConfig(env, network.network);

export const config = {
  ...network,
  ...rpc,
  nodeUrl: rpc.endpoints[0],
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
  release: (env.VITE_RELEASE as string | undefined) || "local",
  sponsoredFpc: env.VITE_SPONSORED_FPC
    ? AztecAddress.fromStringUnsafe(env.VITE_SPONSORED_FPC as string)
    : undefined,
};
