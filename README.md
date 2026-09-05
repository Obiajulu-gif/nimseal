# nimSeal

**Confidential invoices and protected payments inside Nimiq Pay.**

nimSeal is a Nimiq Pay Mini App for freelancers, agencies, contractors and small businesses. You
create an invoice whose commercial terms stay private, seal it with your Nimiq wallet so the buyer
can verify it came from you, and get paid in USDT held in protected escrow — without exposing your
line items, prices, or client relationships on a public ledger.

> **Status.** Built for the **Nimiq Mini Apps Competition — Cycle II**. The app runs today against a
> Sepolia test deployment; Polygon production settlement is a single deploy away (see
> [Deployment](#deployment)). MIT-licensed.

---

## What nimSeal Does

A B2B invoice contains things neither party wants public: line items, unit prices, customer
identities, tax treatment, the discount you gave this client and not that one. Putting that on a
public chain just to get escrow is a bad trade. nimSeal doesn't make you take it.

- **Sellers** compose an invoice inside Nimiq Pay, seal it with their Nimiq wallet, and share a
  payment link.
- **Buyers** open the link, verify the Nimiq seal, and fund the exact amount in USDT through
  protected escrow.
- The escrow contract enforces release, refund and expiry — the money is never in nimSeal's hands.

## Why nimSeal

Existing crypto payment flows either expose too much (everything on-chain) or provide no structured
protection (a bare wallet-to-wallet transfer). nimSeal keeps the commercial detail private, proves
the total off-chain, settles in a USD stablecoin, and adds a wallet-backed proof of origin that a
buyer can check in one glance. It runs where the wallet already is: inside Nimiq Pay, on a phone,
with no extension, no seed phrase, and no separate signup.

## Nimiq Mini Apps Competition — Cycle II

nimSeal is a Nimiq Pay Mini App. It uses **both** providers Nimiq Pay injects:

- the **Nimiq provider** (`@nimiq/mini-app-sdk`) for the wallet-backed invoice seal, and
- the **Ethereum provider** (`window.ethereum`, EIP-1193) for USDT escrow settlement.

See [How It Uses Nimiq Pay](#how-it-uses-nimiq-pay) and [SUBMISSION.md](SUBMISSION.md).

## How It Uses Nimiq Pay

```
┌───────────────────────────────────────────┐
│                Nimiq Pay                   │
│                                            │
│  ┌────────────────┐  ┌──────────────────┐  │
│  │ Nimiq Provider │  │ Ethereum Provider│  │
│  │ @nimiq/mini-   │  │   EIP-1193       │  │
│  │  app-sdk       │  │  window.ethereum │  │
│  └───────┬────────┘  └────────┬─────────┘  │
└──────────┼────────────────────┼────────────┘
           │                    │
           ▼                    ▼
┌───────────────────┐   ┌──────────────────┐
│   Invoice Seal    │   │   USDT Escrow    │
│ Nimiq signature   │   │ Polygon / Sepolia│
│ (Ed25519)         │   │ ERC-20 (6 dec)   │
└─────────┬─────────┘   └────────┬─────────┘
          │                      │
          └───────────┬──────────┘
                      ▼
              ┌───────────────┐
              │    nimSeal    │
              │ Confidential  │
              │   Invoice     │
              └───────┬───────┘
                      │
                      ▼
              ┌───────────────┐
              │   Attestor    │
              │ decrypt •     │
              │ recompute •   │
              │ sign          │
              └───────────────┘
```

- **Nimiq provider** — `init()` from `@nimiq/mini-app-sdk`. Used for `listAccounts()` (identity) and
  `sign()` (the invoice seal).
- **Ethereum provider** — `window.ethereum`, discovered by wagmi over EIP-6963. Used for
  `eth_requestAccounts`, `wallet_switchEthereumChain`, ERC-20 `approve`, and the escrow calls.

## Nimiq Invoice Seal

When a seller creates a confidential invoice, they sign a canonical statement binding the invoice to
their Nimiq identity, through Nimiq Pay:

```
nimSeal Invoice Seal v1
chain:137
escrow:0x…
invoice:14
commitment:0x…
amount:302500
due:1787817137
```

Every field is public on-chain state, so the buyer can reconstruct the exact message and verify — with
no server — that a specific Nimiq wallet sealed exactly this invoice:

1. reproduce Nimiq's signed-message hash (`SHA-256("\x16Nimiq Signed Message:\n" + len + message)`),
2. verify the Ed25519 signature against the seller's public key,
3. derive the Nimiq address (`NQ…`) from that public key — never from the link.

The buyer sees **Nimiq verified · Sealed by NQ…**, with an expandable technical breakdown. The seal
rides in the payment link, so verification needs no backend. Implementation:
[`web/lib/nimiq/seal.ts`](web/lib/nimiq/seal.ts).

## USDT Protected Escrow

Settlement is USDT (6 decimals) held by [`NimSealEscrow`](contracts/contracts/NimSealEscrow.sol):

```
Buyer → approve USDT → fund invoice → escrow holds → release / refund / expiry
```

- Invoices are denominated in **integer USD cents** and settled in a USD stablecoin, so there is no
  oracle, no slippage, and no price to age out — the amount due is fixed when the invoice is created.
- The buyer releases to the seller, the seller can refund, and after `dueAt + grace` the buyer can
  reclaim an unreleased escrow. The owner can never touch escrowed funds.

## User Flow

**Seller**

```
Open nimSeal in Nimiq Pay → Create invoice → enter buyer, amount, due date, line items
→ terms encrypted + committed → attestor validates → seal with Nimiq wallet
→ share payment link
```

**Buyer**

```
Open payment link → verify Nimiq seal → connect via Nimiq Pay
→ approve USDT → fund escrow → track status
```

## Architecture

- **Frontend** — Next.js 15 (App Router) + React 19, Tailwind, wagmi + viem for the EVM side.
  Mobile-first, designed for the Nimiq Pay WebView.
- **Nimiq layer** — [`web/lib/nimiq/`](web/lib/nimiq) (provider wrapper, seal crypto, seal store) and
  [`web/hooks/use-nimiq.ts`](web/hooks/use-nimiq.ts).
- **EVM layer** — [`web/lib/chain.ts`](web/lib/chain.ts), [`web/lib/wagmi.ts`](web/lib/wagmi.ts),
  [`web/lib/contracts.ts`](web/lib/contracts.ts), settlement hooks.
- **Attestor** — a server-side Next.js route ([`web/app/api/attestor`](web/app/api/attestor)) that
  decrypts a private invoice, recomputes every total, and signs only the settlement facts (EIP-712).
- **Contract** — `NimSealEscrow`, an OpenZeppelin-based escrow with a confidential relay path.

## Privacy Model

```
browser encrypts (ECIES) → server decrypts → server recomputes totals
→ server signs validated result (EIP-712) → chain receives minimum settlement facts
```

- **Private, never on-chain**: line items, descriptions, customer identity, tax detail, and the
  commitment's `nonce`/`salt`.
- **Public, on-chain**: seller, buyer, USD total, due date, and a 32-byte `termsCommitment` binding
  the private terms.
- **The attestor is a server key, not a TEE.** An operator with server access can read invoice
  plaintext while it is being validated. nimSeal does **not** claim zero-knowledge, trustless, or
  TEE-secured privacy. What it guarantees: plaintext never reaches the chain, the commitment binds
  the terms, the total was validated before it was signed, and a signed result cannot be replayed.
  See [docs/SECURITY.md](docs/SECURITY.md).

## Technology Stack

| Layer      | Tech |
|------------|------|
| Mini App   | `@nimiq/mini-app-sdk`, `window.ethereum` (EIP-1193) |
| Frontend   | Next.js 15, React 19, Tailwind CSS, wagmi, viem |
| Seal crypto| `@noble/ed25519`, `@noble/hashes` (Ed25519 + SHA-256) |
| Confidential| `ecies-geth` (browser ECIES), viem EIP-712 (attestor) |
| Contract   | Solidity 0.8.27, OpenZeppelin 5, Hardhat |
| Settlement | USDT on Polygon (prod) / mock ERC-20 on Sepolia (test) |

## Repository Structure

```
web/            Next.js Mini App
  lib/nimiq/    Nimiq provider wrapper + invoice-seal crypto
  lib/          EVM chain/wagmi/contracts, attestor wire + validation
  hooks/        wallet, invoices, settlement, Nimiq
  app/          home, dashboard, invoices, pay, attestor API
contracts/      NimSealEscrow + Hardhat (Polygon / Sepolia)
docs/           architecture, security, deployment, confidential flow, demo
scripts/        env check
```

## Getting Started

```bash
make install          # installs web + contracts deps
```

Requires Node 18+ (built on Node 24). Then configure environment
([Environment Variables](#environment-variables)) and run locally.

## Running Locally

```bash
cd web
cp .env.example .env.local   # fill in values
npm run dev                  # binds 0.0.0.0 for LAN device testing
```

Open `http://localhost:3000` in a browser (public pages render; wallet actions need Nimiq Pay), or
open the LAN URL inside Nimiq Pay to use the wallet — see below.

## Testing Inside Nimiq Pay

```
Dev computer runs `npm run dev` (binds 0.0.0.0)
        ↓ same Wi-Fi
Phone → Nimiq Pay → Mini Apps → Custom URL → http://<LAN-IP>:3000
```

1. Find your computer's LAN IP (the dev server prints a `Network:` URL).
2. In Nimiq Pay, open **Mini Apps → Custom URL** and enter `http://<LAN-IP>:3000`.
3. **Testnet:** long-press the Nimiq Pay settings button for 10s to reveal the dev menu, switch to
   Testnet, and use **Get free NIM** (110,000 NIM per request) for Nimiq-native testing. The testnet
   switch affects Nimiq operations only; EVM stays on mainnet chains, so add Sepolia via the wallet
   for EVM testing.

> Loading over an HTTP LAN URL is not a secure context. nimSeal avoids secure-context-only APIs
> where it can and falls back gracefully (clipboard, storage). The ECIES step used by the
> confidential path relies on Web Crypto and is best exercised over HTTPS — see
> [Known Limitations](#known-limitations).

## Environment Variables

**web/.env.local** (see [web/.env.example](web/.env.example))

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_EVM_CHAIN_ID` | `137` (Polygon) or `11155111` (Sepolia) |
| `NEXT_PUBLIC_RPC_URL` / `NEXT_PUBLIC_EXPLORER_URL` | optional overrides |
| `NEXT_PUBLIC_ESCROW_ADDRESS` | deployed `NimSealEscrow` |
| `NEXT_PUBLIC_SETTLEMENT_TOKEN_ADDRESS` | USDT (Polygon) / mock (Sepolia) |
| `NEXT_PUBLIC_ENABLE_PUBLIC_MODE` | expose the unverified public-invoice fallback |
| `ATTESTOR_PRIVATE_KEY` | **server-only** attestor signing key (never `NEXT_PUBLIC_`) |
| `ATTESTOR_ESCROW_ADDRESS` | escrow the attestor mints for (defaults to the public one) |

**contracts/.env** (see [contracts/.env.example](contracts/.env.example)): `DEPLOYER_PRIVATE_KEY`,
optional RPC/explorer overrides, `SETTLEMENT_TOKEN_ADDRESS`, `ATTESTOR_SIGNING_ADDRESS`.

## Contract Development

```bash
cd contracts
npm test                     # 66 tests
npm run coverage
npm run deploy:sepolia       # or deploy:polygon
npm run configure-attestor:sepolia
```

## Deployment

Production is Polygon; the app is served over HTTPS (Vercel works well).

1. Deploy the escrow: `npm run deploy:polygon` (writes `contracts/deployments/polygon-137.json`).
2. Set the attestor address: `npm run configure-attestor:polygon`.
3. Set the web env vars (chain id `137`, escrow address, USDT
   `0xc2132D05D31c914a87C6611C10748AEb04B58e8F`, `ATTESTOR_PRIVATE_KEY` in the host secret store).
4. Build and deploy `web/`.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Values the project owner must supply are listed there.

## Testing

```bash
make verify   # contracts test · web lint · typecheck · unit tests · production build
```

- **Contracts:** 66 Hardhat tests (creation, funding, release, refund, expiry, authorization,
  replay, pausing, confidential relay).
- **Web unit:** 100 Vitest tests including the Nimiq seal (address derivation, signature
  verification, transport) and the attestor/EIP-712 encoding.
- **E2E:** Playwright smoke tests at desktop and 375px mobile viewports (no horizontal overflow).

## Security

- No private keys, seed phrases, or secrets in the repo; `.env.example` files hold placeholders only.
- The attestor key is server-only and never inlined into the browser bundle (`server-only` guard).
- The Mini App never accesses wallet internals or bypasses Nimiq Pay's approval dialogs.

See [docs/SECURITY.md](docs/SECURITY.md).

## Known Limitations

- **Attestor trust.** The confidential path trusts a server key, not a TEE. Not zero-knowledge.
- **HTTP LAN dev.** ECIES encryption relies on Web Crypto, which is most reliable over HTTPS. Prefer
  an HTTPS tunnel (or the deployed URL) when exercising the confidential path inside Nimiq Pay.
- **Unaudited.** Experimental software; the contract has not been audited.

## Competition Submission

See [SUBMISSION.md](SUBMISSION.md) for the competition description, compliance checklist, and demo
script.

## Team

Solo build by the project owner (`Obiajulu-gif`). See SUBMISSION.md.

## License

[MIT](LICENSE).
