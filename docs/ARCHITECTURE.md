# Architecture

## Components

| Component | Runs where | Trusted for |
|---|---|---|
| Browser app (`web/`) | User's device | Generating entropy, encrypting, holding plaintext transiently |
| Attestor (`web/app/api/attestor/`) | The app's own server runtime | Decrypting, validating, computing totals, signing |
| `NimSealEscrow` (`contracts/`) | Polygon / Sepolia | Signature verification, replay protection, custody |
| USDT | Polygon / Sepolia | Settlement asset |

Four boxes, and one of them used to be a Docker Compose stack with a Go toolchain, a Redis instance
and an HTTPS tunnel. The confidential path is now two route handlers in the same Next.js app that
serves the UI, because the only thing that ever needed to be co-located with an enclave was the
private key — and there is no enclave.

## Trust boundaries

```
┌─ User's device ─────────────────┐
│  plaintext invoice              │  ← never leaves except as ciphertext
│  nonce, salt (32 bytes each)    │
└───────────┬─────────────────────┘
            │ ECIES to the attestor's public key
┌───────────▼─────────────────────┐
│  Attestor process               │  ← the only place plaintext is readable after encryption
│  decrypt, validate, sign        │     (an operator with server access can read it here)
└───────────┬─────────────────────┘
            │ EIP-712 signature over settlement facts only
┌───────────▼─────────────────────┐
│  Public chain                   │  ← sees parties, total, due date, commitment. Never the terms.
└─────────────────────────────────┘
```

Three parties are trusted with distinct things, and none with everything:

- The **browser** sees plaintext, but it is the user's own device.
- The **attestor** sees plaintext but cannot move funds. It only signs a statement; the escrow
  decides what that signature is worth.
- The **chain** sees the settlement facts and a hash, never the terms.

The escrow trusts exactly one key: `attestorAddress`. Compromising it lets an attacker mint invoices
with arbitrary totals, but still not touch escrowed USDT — funding, release and refund are gated on
the buyer and seller addresses, not on the attestor.

**Note the asymmetry with the enclave design this replaces.** A real TEE would mean an operator
*cannot* read plaintext. A server key means an operator *can*, and simply does not. That is a policy
guarantee, not a technical one. [SECURITY.md](SECURITY.md) does not soften this.

## On-chain versus private

| Field | On-chain | Private |
|---|---|---|
| Seller, buyer | ✅ | |
| USD total (cents) | ✅ | |
| Due date | ✅ | |
| Terms commitment | ✅ | |
| Attestation id | ✅ | |
| USDT amount | ✅ (after funding) | |
| Line item descriptions | | ✅ |
| Quantities, unit prices | | ✅ |
| Invoice reference | | ✅ |
| Tax and discount breakdown | | ✅ (only the net total is public) |
| Nonce, salt | | ✅ |

The commitment is what makes the private half provable later: the seller reveals the payload and
anyone can recompute the hash. Because it mixes in 32 bytes of nonce and 32 of salt, it cannot be
brute-forced back to the line items even for a small, guessable invoice.

Unlike the design this replaces, **the ciphertext is never written to the chain.** It goes to the
attestor over HTTPS and is discarded. That removes a permanent public artifact — but it also means
there is no on-chain record of the encrypted payload to appeal to in a dispute, so the seller is
responsible for retaining the plaintext they will need to reveal.

## Interaction sequence

```
Seller browser              Attestor                Escrow
     │                          │                      │
     │─ GET /api/attestor/info ▶│                      │
     │◀── publicKey, address ───│                      │
     │                          │                      │
     │─ encrypt(payload) ───────│                      │
     │─ POST /create ──────────▶│ decrypt              │
     │                          │ validate             │
     │                          │ recompute total      │
     │                          │ derive commitment    │
     │                          │ derive attestationId │
     │◀── attestation + sig ────│ sign EIP-712         │
     │                          │                      │
     │─ relayConfidentialInvoice(attestation, sig) ────▶│ verify EIP-712
     │                          │                      │ consume attestationId
     │                          │                      │ create Invoice
Buyer browser                                          │
     │─ quoteInvoice(id) ──────────────────────────────▶│ view, no oracle
     │─ approve(USDT, required) ───────────────────────▶│
     │─ fundInvoice(id) ───────────────────────────────▶│ recomputes the amount itself
     │─ releasePayment(id) ────────────────────────────▶│ transfers to seller
```

**The seller signs one transaction.** The previous design paid for an on-chain instruction
transaction to hand ciphertext to a registry, then polled a proxy until an enclave picked it up and
returned a result, then relayed that result — two wallet confirmations and an indefinite wait in
between. Calling the attestor directly removes the first transaction, the polling loop, the action-id
extraction and two states from the frontend's state machine.

## Unit math

Everything is integer arithmetic. There is no floating point in the browser, the attestor or the
contract.

**Cents to token units**, in `NimSealEscrow._usdCentsToTokens`:

```
amount = ceil(usdAmountCents × 10^dec / 100)
```

`10^dec` is `tokenScale`, cached at construction from `SETTLEMENT_TOKEN.decimals()` — so a token
that later changes its reported decimals cannot re-price existing invoices.

For a 6-decimal stablecoin this is `cents × 10⁴`, and it is **exact**: the ceiling never engages,
because 10⁶ is divisible by 100. The rounding mode matters only for a hypothetical token with fewer
than two decimals, where rounding up keeps the escrow from being under-funded by truncation. The
deploy script refuses such a token anyway.

| Invoice | Required USDT |
|---|---|
| $100.00 (10 000 cents) | 100.000000 |
| $0.01 (1 cent) | 0.010000 |
| $1,234,567.89 (123 456 789 cents) | 1234567.890000 |

**There is no price feed, no freshness window and no slippage ceiling.** A USD invoice settled in a
USD stablecoin has nothing to price. The amount due is fixed when the invoice is created and cannot
move between the quote and the funding transaction, so `quoteInvoice` is a plain `view` and
`fundInvoice` takes no amount from the caller at all — it recomputes the figure itself and transfers
exactly that.

This is the single largest simplification in the port. The oracle-priced version needed
`_readXrpUsdPrice`, a feed id, `maxPriceAge`, `StalePrice`, `InvalidPrice`, `SlippageExceeded`, a
`payable` non-view quote function, a simulation call in the frontend, a refetch interval, a
slippage selector in the UI, and a staleness display. All of it existed to manage a risk that
stablecoin settlement does not have.

## Invoice state machine

```
        createPublicInvoice
        relayConfidentialInvoice
                 │
                 ▼
             ┌────────┐  cancelInvoice (seller)   ┌───────────┐
             │Pending │──────────────────────────▶│ Cancelled │
             └───┬────┘                           └───────────┘
                 │ fundInvoice (buyer, before dueAt)
                 ▼
             ┌────────┐  releasePayment (buyer)   ┌──────────┐
             │ Funded │──────────────────────────▶│ Released │
             └───┬────┘                           └──────────┘
                 │ refundBuyer (seller)
                 │ claimExpiredRefund (buyer, after dueAt + grace)
                 ▼
             ┌──────────┐
             │ Refunded │
             └──────────┘
```

Released, Refunded and Cancelled are terminal. Every transition sets state before transferring
tokens, and every token-moving function is `nonReentrant`.
