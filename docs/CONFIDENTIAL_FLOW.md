# The confidential flow

What happens between typing an invoice and having one on-chain, in the order it happens, with the
exact artifacts at each step.

---

## 1. The browser builds a private payload

`web/lib/invoice.ts` assembles a `PrivateInvoicePayload`. Every monetary field is a **decimal
string**, not a JSON number, specifically so parsing cannot round it:

```json
{
  "version": 1,
  "seller": "0x…",
  "buyer": "0x…",
  "escrowContract": "0x…",
  "invoiceReference": "INV-2026-014",
  "dueAt": 1787817137,
  "currency": "USD",
  "items": [
    { "description": "Design retainer, March", "quantity": "2", "unitPriceCents": "125000" },
    { "description": "Hosting, Q1", "quantity": "3", "unitPriceCents": "1999" }
  ],
  "discountCents": "10000",
  "taxCents": "5025",
  "nonce": "<32 bytes of entropy>",
  "salt":  "<32 bytes of entropy>"
}
```

`nonce` and `salt` come from `crypto.getRandomValues`. They exist to make the commitment **hiding**:
without them, an invoice for a round number from a known seller to a known buyer could be
brute-forced out of its hash in seconds.

This object is sensitive in full. It lives only as a local `const` inside the creation function —
never React state, `localStorage`, a URL, a toast, or an error report.

## 2. The browser encrypts it

```
ciphertext = ECIES(attestorPublicKey, JSON.stringify(payload))
```

`ecies-geth` — the JavaScript port of go-ethereum's ECIES (`ECIES_AES128_SHA256` over secp256k1).
The public key comes from `GET /api/attestor/info`, which also reports the address the escrow
verifies against and the escrow the attestor is bound to. The frontend checks both before
encrypting: an attestor configured for a different chain or a different escrow produces a signature
that can never be relayed, and failing early is better than failing at the wallet.

No cryptography is implemented in this project. Both sides call the same library.

## 3. The attestor validates

`POST /api/attestor/create` with `{ ciphertext }`. The route decrypts, parses, and hands the result
to `validateInvoice`, which is where the real work is:

| Check | Failure |
|---|---|
| `version === 1`, `currency === "USD"` | rejected |
| seller, buyer, escrowContract are valid addresses | rejected |
| seller ≠ buyer | rejected |
| escrowContract matches the attestor's configured escrow | rejected |
| 1–20 items, each with a 1–200 char description | rejected |
| quantity is a decimal string in [1, 1 000 000] | rejected |
| unitPriceCents is a positive decimal string | rejected |
| nonce and salt are ≥ 32 chars | rejected |
| dueAt is in the future and ≤ 366 days out | rejected |
| discount ≤ subtotal | rejected |
| final total > 0 and ≤ $100 000 000 | rejected |

Then it recomputes:

```
subtotal   = Σ (quantity × unitPriceCents)
finalTotal = subtotal − discountCents + taxCents
```

as `bigint`. **The browser's own arithmetic is never trusted.** The UI computes a total for display,
but the number that gets signed is the one derived here from the line items.

Validation failures return **422** with a message naming the field and the rule — never the
submitted value. The message is shown to the user, so echoing content would leak the thing the
whole design exists to protect. There is a test asserting a rejected invoice's description does not
appear in the error.

A ciphertext that will not decrypt returns **400** with a single uniform message. Distinguishing
"wrong key" from "malformed ciphertext" would be an oracle worth denying.

## 4. The attestor derives the commitment

```
termsCommitment = keccak256(abi.encode(
    keccak256("NIMSEAL_INVOICE_V1"),
    seller, buyer, escrowContract,
    keccak256(invoiceReference),
    itemsHash,                      // keccak over the concatenated per-item hashes, in order
    discountCents, taxCents, finalTotalCents,
    dueAt,
    keccak256(nonce), keccak256(salt)
))
```

Each item hashes as `keccak256(abi.encode(keccak(description), quantity, unitPrice, lineTotal))`,
and `itemsHash` is the keccak of those concatenated in submission order — so reordering the items
changes the commitment.

Deterministic and hiding: the same normalised inputs always give the same value, so a seller can
prove exactly what was invoiced by revealing the payload; and the 64 bytes of entropy mean nobody
can go the other way.

## 5. The attestor derives a single-use id

```
attestationId = keccak256(abi.encode(termsCommitment, seller))
```

Deterministic on purpose. Two invoices with identical terms still differ here, because the
commitment mixes in fresh per-invoice entropy. What determinism buys is **idempotency**: a seller
who submits the same invoice twice gets the same id back, and the escrow's replay guard turns the
second relay into `AttestationAlreadyConsumed` rather than a duplicate invoice.

## 6. The attestor signs

EIP-712 typed data:

```
domain = { name: "nimSeal", version: "1", chainId, verifyingContract: <escrow> }

ConfidentialInvoice(
  address seller,
  address buyer,
  uint256 usdAmountCents,
  uint64  dueAt,
  bytes32 termsCommitment,
  bytes32 attestationId
)
```

The domain binds every signature to one chain and one escrow contract. That is why the struct has no
`escrowContract` field — a signature minted for another deployment simply will not verify, so a
redundant field would only be a second thing to check and a second thing to get wrong.

The response carries the six fields plus a 65-byte signature. Amounts cross as strings, because JSON
has no bigint.

## 7. The seller relays

```solidity
relayConfidentialInvoice(ConfidentialInvoice calldata attestation, bytes calldata signature)
```

The contract, in order:

1. `attestorAddress != 0` — else `AttestorNotConfigured`
2. `attestationId != 0` — else `InvalidAttestationId`
3. `attestationId` unconsumed — else `AttestationAlreadyConsumed`
4. `attestation.seller == msg.sender` — else `InvalidResultSeller`
5. `ECDSA.recover(_hashTypedDataV4(structHash), signature) == attestorAddress` — else
   `InvalidAttestorSignature`
6. marks the id consumed
7. creates the invoice, which re-checks buyer ≠ 0, buyer ≠ seller, amount > 0, commitment ≠ 0,
   dueAt in the future

Step 4 matters: **the seller submits their own invoice.** Anyone holding a copy of the signature
cannot create the invoice on the seller's behalf.

Steps 6 and 7 are ordered so that a relay which reverts in creation does **not** burn the id. There
is a test for exactly that — it fails a relay, asserts the id is still unconsumed, then relays the
original successfully.

`hashConfidentialInvoice(attestation)` is exposed as a public view so the attestor and its tests can
assert they are signing precisely what the contract will verify, rather than reimplementing the
encoding and hoping. The web test pins the type string and a golden digest generated independently
with ethers; the contract test pins its own `hashConfidentialInvoice` against the same encoding. If
those two ever drift, every signature becomes unrelayable, and it would otherwise only surface at
relay time.

## 8. Settlement

Nothing confidential remains. The buyer reads `quoteInvoice(id)` — a plain view returning
`ceil(cents × 10^dec / 100)` — approves exactly that amount, and calls `fundInvoice(id)`, which
recomputes the figure itself rather than accepting one. Then `releasePayment`, `refundBuyer` or
`claimExpiredRefund` per the state machine.

---

## What can go wrong, and what the user sees

| Condition | HTTP / revert | Shown as |
|---|---|---|
| `ATTESTOR_PRIVATE_KEY` unset | 503 | The attestor service is unavailable |
| Attestor bound to another chain or escrow | — (client-side check) | Named mismatch, before any signing |
| Ciphertext will not decrypt | 400 | The payload could not be decrypted |
| Invoice fails a rule | 422 | The field and the rule that failed |
| Escrow has no attestor set | `AttestorNotConfigured` | The escrow has no attestor signing address configured yet |
| Signature for another chain/escrow/values | `InvalidAttestorSignature` | The signature is not valid for this escrow and chain |
| Relayed twice | `AttestationAlreadyConsumed` | This result has already been used to create an invoice |
| Relayed by someone other than the seller | `InvalidResultSeller` | — |

## Verifying a running service

```bash
cd web && npm run check-attestor
```

Encrypts a real invoice against the live service and asserts the total was recomputed rather than
trusted, the signature recovers to the advertised address, the id is deterministic across two
submissions, an invalid invoice is refused with 422, and a garbage ciphertext fails with a uniform
400. Read-only — it sends no transaction and needs no key.
