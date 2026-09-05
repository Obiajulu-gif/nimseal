# Migration notes — BOT Chain → Nimiq Pay

BotSeal began as a confidential-invoice escrow that ran on BOT Chain (and, before that, on Flare).
For the Nimiq Mini Apps Competition (Cycle II) it was substantially rebuilt around the Nimiq Pay
provider architecture. This file records what changed and why, so the history is legible without
implying BOT Chain is still involved. **Nothing in the shipped app depends on BOT Chain.**

## What was kept

The parts that made BotSeal distinctive were portable and stayed:

- The **confidential invoice** model: browser-side encryption, an off-chain attestor that decrypts,
  recomputes every total, and signs only the settlement facts (EIP-712), and a 32-byte terms
  commitment binding the private terms.
- The **`BotSealEscrow`** contract and its full state machine (create, fund, release, refund, expiry,
  cancel), replay protection, attestor-signature verification, pausing, and its 66 tests. It is a
  standard EVM contract, so it moved networks without a rewrite — only comments changed.
- Integer-cent money arithmetic and the deterministic commitment/attestation-id derivation.

## What was removed

Everything that coupled the app to BOT Chain:

- BOT Chain RPCs, explorers, chain ids (677 / 968), the native BOT/tBOT token, BOTScan/Bohr links,
  the mainnet deployment records and addresses, BOT Chain Hardhat networks and smoke scripts, and
  the BOT-Chain-specific README/SUBMISSION/docs and env files.

## What was added or changed

- **Nimiq Pay providers.** The generic injected-EVM wallet was reframed around the two providers
  Nimiq Pay injects: the Nimiq provider (`@nimiq/mini-app-sdk`) and the Ethereum provider
  (`window.ethereum`, discovered by wagmi over EIP-6963). No MetaMask/WalletConnect requirement.
- **Nimiq Invoice Seal.** A new, meaningful Nimiq-native trust interaction: the seller signs the
  invoice's canonical facts with their Nimiq key, and the buyer verifies the Ed25519 signature and
  derives the `NQ…` address entirely client-side. See [`web/lib/nimiq/seal.ts`](web/lib/nimiq/seal.ts).
- **Settlement network.** USDT escrow moved to Polygon (production) / Sepolia (testing), the EVM
  chains Nimiq Pay exposes. Real Polygon USDT (`0xc2132D05D31c914a87C6611C10748AEb04B58e8F`, 6 dec).
- **Mobile-first UX.** The desktop dApp layout was rebuilt for the Nimiq Pay WebView: compact header,
  bottom navigation, short forms, an outside-Nimiq-Pay fallback, and a 375px-verified responsive pass.
- **Deploy tooling.** BOT Chain scripts were renamed/generalised (`scripts/networks.ts`,
  `deploy.ts`, `smoke.ts`) and the Hardhat config now targets `polygon` / `sepolia`.

For the current design, see [README.md](README.md) and [docs/](docs).
