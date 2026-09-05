/**
 * Wagmi configuration for the Nimiq Pay EVM provider.
 *
 * Inside Nimiq Pay the wallet is injected at `window.ethereum` and announced over EIP-6963, which
 * wagmi discovers automatically — no WalletConnect project id, no browser extension, no MetaMask.
 * The `injected()` connector is kept as a fallback so the same build also works in a desktop
 * browser that has an injected EVM wallet, which is only used for local development.
 */

import { createConfig, http } from "wagmi";
// Imported from @wagmi/core rather than the `wagmi/connectors` barrel: that barrel pulls in every
// connector, including Base Account's SDK and its optional @x402/* peers, which are not installed
// and break the production build.
import { injected } from "@wagmi/core";

import { settlementChain, rpcUrl } from "./chain";

export const wagmiConfig = createConfig({
  chains: [settlementChain],
  connectors: [injected({ shimDisconnect: true })],
  // EIP-6963 discovery is on by default, so Nimiq Pay's provider is picked up without announcing it.
  transports: {
    [settlementChain.id]: http(rpcUrl()),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
