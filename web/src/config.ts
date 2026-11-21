import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { NAME_SUFFIX } from "fog-sdk/read";

import { parseHostingConfig, parseNetworkConfig, parseRpcConfig } from "./network-config";

const env = import.meta.env;
const network = parseNetworkConfig(env);
const rpc = parseRpcConfig(env, network.network);
const hosting = parseHostingConfig(env);

export const config = {
  ...network,
  ...rpc,
  ...hosting,
  nodeUrl: rpc.endpoints[0],
  registry: env.VITE_REGISTRY
    ? AztecAddress.fromStringUnsafe(env.VITE_REGISTRY as string)
    : undefined,
  /** Every name displays as `<label>.fog`; input may include or omit it. */
  nameSuffix: NAME_SUFFIX,
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

/** Absolute URL of a Fog API path (`/api/status`) on the API Worker; relative when the site serves its own API. */
export const apiUrl = (path: `/api/${string}`) => `${config.apiOrigin}${path}`;
