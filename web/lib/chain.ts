/**
 * EVM settlement-chain definition and the shared public client.
 *
 * nimSeal settles in USDT through the EVM provider that Nimiq Pay injects at `window.ethereum`
 * (EIP-1193, discoverable via EIP-6963). Those chains are standard public networks, so their
 * definitions come from viem rather than being hand-declared:
 *
 *   - Polygon (137)   — production settlement in real USDT.
 *   - Sepolia (11155111) — development and testing against a 6-decimal mock ERC-20.
 *
 * The active chain is selected by `NEXT_PUBLIC_EVM_CHAIN_ID`. A configured RPC or explorer always
 * wins over viem's defaults, so a private RPC works without a code change.
 */

import { createPublicClient, http, type Chain } from "viem";
import { polygon, sepolia } from "viem/chains";

import { env } from "./env";

export const POLYGON_CHAIN_ID = 137;
export const SEPOLIA_CHAIN_ID = 11155111;

/** The EVM chains Nimiq Pay exposes that nimSeal supports for settlement. */
const SUPPORTED_CHAINS: Record<number, Chain> = {
  [POLYGON_CHAIN_ID]: polygon,
  [SEPOLIA_CHAIN_ID]: sepolia,
};

/**
 * The EVM chain this build settles on.
 *
 * Selected by `NEXT_PUBLIC_EVM_CHAIN_ID` so a Sepolia test build and the Polygon production build
 * differ only by environment. An unrecognised id is a configuration error rather than something to
 * guess at — silently defaulting is how funds end up on the wrong network.
 */
function resolveChain(): Chain {
  const base = SUPPORTED_CHAINS[env.chainId];

  if (base === undefined) {
    throw new Error(
      `NEXT_PUBLIC_EVM_CHAIN_ID=${env.chainId} is not a supported Nimiq Pay EVM network. ` +
        `Use ${POLYGON_CHAIN_ID} (Polygon, production) or ${SEPOLIA_CHAIN_ID} (Sepolia, testing).`,
    );
  }

  // Honour a configured RPC and explorer; otherwise keep viem's public defaults.
  return {
    ...base,
    rpcUrls: env.rpcUrl
      ? { default: { http: [env.rpcUrl] } }
      : base.rpcUrls,
    blockExplorers: env.explorerUrl
      ? { default: { name: base.blockExplorers?.default.name ?? "Explorer", url: env.explorerUrl } }
      : base.blockExplorers,
  } as Chain;
}

/** The EVM settlement chain. Exported under a neutral name; it is Polygon or Sepolia at runtime. */
export const settlementChain: Chain = resolveChain();

/** The hex chain id (`0x89`, `0xaa36a7`) for `wallet_switchEthereumChain`. */
export const settlementChainIdHex = `0x${settlementChain.id.toString(16)}` as const;

/** Whether this build settles on a testnet. */
export const isTestnet = settlementChain.id === SEPOLIA_CHAIN_ID;

/** The best RPC URL: configured override, else the chain's first default. */
export function rpcUrl(): string {
  return env.rpcUrl ?? settlementChain.rpcUrls.default.http[0]!;
}

/** The block-explorer base URL for the active chain. */
export function explorerBaseUrl(): string {
  return (env.explorerUrl ?? settlementChain.blockExplorers?.default.url ?? "").replace(/\/+$/, "");
}

/** Read-only client for server components and non-wallet reads. */
export const publicClient = createPublicClient({
  chain: settlementChain,
  transport: http(rpcUrl()),
});
