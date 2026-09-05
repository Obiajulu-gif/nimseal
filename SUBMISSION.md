# BotSeal — Nimiq Mini Apps Competition (Cycle II)

**Project Name:** BotSeal
**Tagline:** Confidential invoices and protected payments, inside Nimiq Pay.
**Category:** Payments / Business tools (Nimiq Pay Mini App)

---

## Problem

Business invoices carry things neither party wants public: line items, unit prices, customer
identities, tax treatment, per-client discounts. Today's crypto payment flows force a bad trade —
either everything lands on a public ledger to get escrow, or you settle with a bare wallet transfer
that carries no structure, no protection, and no proof of who issued it.

## Solution

BotSeal lets a seller create an invoice whose commercial terms stay encrypted off-chain, seal it
with their Nimiq wallet so the buyer can verify its origin, and receive USDT held in protected
escrow. Only the minimum settlement facts — parties, USD total, due date, and a 32-byte commitment —
ever reach the chain.

## Target Users

Freelancers, agencies, contractors, small businesses, and cross-border service providers who invoice
in USD and want privacy plus payment protection without a bank or a public ledger dump.

## Why It Is Useful

It replaces "send me crypto to this address" with a real invoice: private terms, a verifiable seal,
a fixed USD amount, and escrow rules a contract enforces — all in the wallet the user already has.

## How BotSeal Uses Nimiq Pay

BotSeal runs inside the Nimiq Pay WebView and uses both injected providers:

- **Nimiq provider** (`@nimiq/mini-app-sdk` `init()`): `listAccounts()` for identity and `sign()` for
  the invoice seal.
- **Ethereum provider** (`window.ethereum`, EIP-1193, discovered via EIP-6963): `eth_requestAccounts`,
  `wallet_switchEthereumChain`, ERC-20 `approve`, and the escrow calls (`eth_sendTransaction`,
  `eth_call`).

No MetaMask, no WalletConnect, no seed phrase, no signup — Nimiq Pay is the wallet host.

## How BotSeal Uses Nimiq

The **Nimiq Invoice Seal** is a real trust primitive, not a connection indicator. The seller signs a
canonical statement binding the invoice's public facts (chain, escrow, invoice id, commitment,
amount, due date) with their Nimiq key. The buyer's payment link reproduces Nimiq's signed-message
hash, verifies the Ed25519 signature, and derives the seller's `NQ…` address from the public key —
entirely client-side, no server. The buyer sees **Nimiq verified · Sealed by NQ…**.

## How USDT Works

Invoices are denominated in integer USD cents and settled in USDT (6 decimals) through the escrow
contract: buyer approves, funds the exact amount, and releases to the seller; the seller can refund;
after the due date plus a grace period the buyer can reclaim. No oracle, no slippage — a USD invoice
settled in a USD asset. Production USDT is Polygon `0xc2132D05D31c914a87C6611C10748AEb04B58e8F`.

## What Makes It Original

A wallet-backed, self-verifying seal on a *confidential* invoice. Most Mini Apps use the wallet to
move money; BotSeal also uses it to prove authorship of a document whose contents stay private — and
the proof travels in the payment link with no backend.

## Privacy Model

Browser encrypts (ECIES) → attestor decrypts → recomputes every total → signs only the settlement
facts (EIP-712) → chain stores the minimum. Line items, identities, tax detail and the
commitment's entropy never reach the chain. **The attestor is a server key, not a TEE** — BotSeal
does not claim zero-knowledge or trustless privacy. See [docs/SECURITY.md](docs/SECURITY.md).

## Architecture

See [README.md](README.md#how-it-uses-nimiq-pay) for the full diagram. Next.js 15 Mini App · Nimiq +
Ethereum providers · off-chain attestor (Next.js route) · `BotSealEscrow` on Polygon/Sepolia.

## Main User Flow

Seller: open in Nimiq Pay → create invoice → attestor validates → seal with Nimiq wallet → share
link. Buyer: open link → verify seal → approve USDT → fund escrow → track status.

## Technical Stack

Next.js 15, React 19, Tailwind, wagmi + viem, `@nimiq/mini-app-sdk`, `@noble/ed25519`/`@noble/hashes`,
`ecies-geth`, Solidity 0.8.27 + OpenZeppelin 5 + Hardhat.

## Repository

`https://github.com/Obiajulu-gif/nimseal` — branch **`nimiq-main`**. MIT licensed.

## Live App

`LIVE_APP_URL_TO_BE_PROVIDED` (deploy `web/` to Vercel over HTTPS; see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

## Testing Instructions

1. `make install`
2. `cd web && cp .env.example .env.local` (set `NEXT_PUBLIC_EVM_CHAIN_ID=11155111` for Sepolia)
3. `npm run dev` (binds `0.0.0.0`)
4. Nimiq Pay → Mini Apps → Custom URL → `http://<LAN-IP>:3000`
5. `make verify` runs the full offline gate (contracts, lint, types, unit tests, build).

## Team

Solo build by the project owner (GitHub `Obiajulu-gif`).

## Nimiq Prize Wallet

```
NIMIQ_PRIZE_WALLET_TO_BE_PROVIDED
```

*(Placeholder — the project owner must supply the real Nimiq payout address. Do not treat this as a
valid address.)*

## Known Limitations

- Attestor trust is a server key, not a TEE; not zero-knowledge.
- The confidential ECIES path is most reliable over HTTPS (Web Crypto).
- Contract is unaudited, experimental software.

---

## Competition Description (≤250 words)

BotSeal is a Nimiq Pay Mini App for confidential invoicing and protected settlement. It's built for
freelancers, agencies, contractors and small businesses who invoice in USD and don't want their line
items, prices and client relationships written to a public ledger just to get payment protection.

A seller opens BotSeal inside Nimiq Pay and composes an invoice. The commercial detail is encrypted
in the browser; an off-chain attestor decrypts it, recomputes every total, and signs only the
settlement facts. The seller then seals the invoice with their Nimiq wallet — signing a canonical
statement that binds the invoice to their Nimiq identity. That seal is the heart of the integration:
the buyer's payment link verifies the Ed25519 signature and derives the seller's NQ address
client-side, showing "Nimiq verified · Sealed by NQ…" with no server involved. The wallet doesn't
just move money here; it proves who issued a document whose contents stay private.

Settlement uses the Ethereum provider Nimiq Pay injects: the buyer approves and funds USDT into an
escrow contract that enforces release, refund and expiry. Only parties, USD total, due date and a
32-byte commitment ever touch the chain.

The whole flow is mobile-first and needs no extension, seed phrase or signup — Nimiq Pay is the
wallet. BotSeal is honest about its trust model: the attestor is a server key, not a TEE, and never
claims zero-knowledge. What it delivers is private invoicing, wallet-backed proof of origin, and
protected USDT settlement, in the wallet users already carry.

---

## Compliance Checklist

```
[x] Public GitHub repository
[x] MIT License (root LICENSE + package.json)
[x] Built as a Nimiq Pay Mini App
[x] Uses Nimiq Pay wallet infrastructure (Nimiq + Ethereum providers)
[x] Supports USDT settlement (and Nimiq-native signing)
[x] Meaningful Nimiq integration (wallet-backed invoice seal, verified client-side)
[x] No hardcoded private keys
[x] No exposed secrets (.env.example placeholders only)
[x] Functional product (builds, runs, 166 automated tests pass)
[x] Mobile responsive (375px verified, no horizontal overflow)
[x] Local testing path inside Nimiq Pay documented
[x] Competition description <= 250 words
[x] Team information prepared
[ ] Nimiq payout wallet supplied by project owner
[x] Demo script prepared
[ ] Production Polygon deployment + live HTTPS URL (owner action)
```

---

## Demo Script (90–120s)

```
0:00–0:10  Problem
  "Business invoices carry private terms. Most crypto payment flows expose everything,
   or give you no protection at all."

0:10–0:25  Open BotSeal inside Nimiq Pay
  Home screen: "Private invoices. Protected payments." Tap Create invoice.

0:25–0:50  Seller creates a confidential invoice
  Enter buyer, amount, due date, line items. Show the live total.
  Attestor validates and signs. Show "Attestor online".

0:50–1:05  Seal with Nimiq
  Tap "Seal with Nimiq wallet" → confirm in Nimiq Pay.
  Card flips to "Sealed by NQ…". Tap Share payment link.

1:05–1:30  Buyer opens the link
  Show the green "Nimiq verified · Sealed by NQ…" badge; expand the technical details.
  Show amount, seller, due date. Approve USDT, then Fund escrow.

1:30–1:45  Funded
  Status → Funded. Show escrow protection and the transaction on the explorer.

1:45–2:00  Dashboard
  Both invoices listed with status. Close: "Private terms. Protected settlement.
  All inside Nimiq Pay."
```
