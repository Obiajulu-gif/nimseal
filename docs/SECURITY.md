# Security

An honest account of what BotSeal protects, what it does not, and what would have to be true before
it could hold real money.

---

## The attestor is a server key, not a TEE

This is the largest gap in the system and everything else is smaller than it.

The attestor is an ordinary process holding an ordinary secp256k1 private key. There is no enclave,
no hardware attestation, no code-hash proof of what is running. Concretely:

- **An operator with server access can read every invoice** while it is being validated.
- An operator with the key can mint settlement facts the escrow will accept.
- Nothing proves to a user that the code processing their invoice is the code in this repository.

The design still keeps plaintext off the chain, binds the terms with a commitment, and recomputes
every total before signing. Those are real properties. But confidentiality here rests on **who runs
the server**, not on mathematics or silicon. A user who does not trust the operator gets nothing
from this that a plain database would not give them.

What would close the gap: running the validator inside an attested enclave with reproducible builds
and publishing the code hash, so a user can verify *which* code holds the key. That is future work;
this version does not claim it.

**Do not describe this as a TEE.** There is no hardware attestation here — only a server key operated
by the project.

---

## Encrypted in transit is not permanent privacy

The ciphertext is sent to a server we operate and discarded after validation. It is not written to
the chain, which removes the permanent public artifact the previous design had.

What remains public and permanent is the **commitment** — a hash. That is safe against preimage
attack today, and it mixes in 64 bytes of entropy so it cannot be brute-forced back to a small
invoice.

Still true:

- Anyone who compromises the attestor host while an invoice is in flight sees plaintext.
- TLS protects the payload in transit; the ECIES layer means a TLS-terminating proxy still cannot
  read it, which is the point of encrypting client-side rather than relying on transport security.
- The seller must retain their own plaintext. There is no on-chain copy to appeal to later, so the
  ability to *prove* the terms depends on the seller keeping the payload that hashes to the
  commitment.

---

## Attestor signer administration

The escrow verifies against exactly one address, `attestorAddress`, set by the owner.

**Risk.** Whoever controls the owner key controls which signer the escrow trusts. A malicious or
compromised owner can point it at a key they hold and mint invoices with arbitrary totals and
commitments.

**Bounded by.** A rogue signer still cannot move money:

- `fundInvoice` requires `msg.sender == invoice.buyer`.
- `releasePayment` requires the buyer.
- `refundBuyer` requires the seller.
- There is **no owner path to escrowed funds** — `recoverUnsupportedToken` reverts with
  `CannotRecoverEscrowToken` for the settlement token.

So the worst case is fabricated invoices that no buyer is obliged to fund, not theft.

**Mitigations for production.** Put the owner behind a multisig or timelock, and emit/monitor
`AttestorAddressUpdated`. Rotating the address does not invalidate existing invoices, which is
deliberate — settlement of past invoices must not depend on current signer configuration. There is a
test asserting a rotated attestor leaves an existing funded invoice settleable.

---

## Signature scope

EIP-712, with the domain binding `chainId` and `verifyingContract`. A signature is therefore usable
on exactly one chain, against exactly one escrow, for exactly one set of values.

| Attack | Outcome |
|---|---|
| Replay the same attestation | `AttestationAlreadyConsumed` |
| Relay a testnet signature on mainnet | `InvalidAttestorSignature` (chainId in domain) |
| Relay a signature minted for another deployment | `InvalidAttestorSignature` (verifyingContract in domain) |
| Alter any field after signing | `InvalidAttestorSignature` |
| Relay someone else's attestation | `InvalidResultSeller` |
| Fail a relay, then retry | id was never consumed; the retry works |

`attestationId` is derived from the commitment, which mixes in per-invoice entropy — so the id is
unpredictable to anyone who has not seen the payload, and cannot be squatted by a third party
front-running a known invoice.

---

## No price feed to attack

The previous design read an oracle at funding time and needed staleness bounds, a slippage ceiling
and a freshness display. All of that is gone: a USD total settled in a USD stablecoin has nothing to
price.

The amount due is fixed when the invoice is created and derived from the invoice's own stored cent
total. `fundInvoice` accepts **no amount from the caller** — it recomputes the figure and transfers
exactly that. There is no oracle to manipulate, no window in which a quote can go stale, and no path
by which a buyer can influence what they pay.

The residual assumption is that **USDT is worth a dollar.** If it depegs, an invoice denominated in
dollars settles in a token worth less than its face value. That risk is real, is not mitigated here,
and is the honest cost of removing the oracle. It is also a risk both parties can see and price,
unlike an oracle failure.

---

## Settlement-token integrity

`tokenScale` is `10 ** decimals()`, cached at construction. A token that later changes its reported
decimals cannot re-price existing invoices.

The deploy script refuses:

- A mainnet token that does not report `USDT` and 6 decimals.
- Any token reporting more than 18 or fewer than 2 decimals.
- A testnet run pointed at the mainnet USDT address — that address holds an unrelated 18-decimal
  token on Sepolia, and deploying against it would mis-scale every invoice by 10¹².

The smoke script re-checks `tokenScale == 10 ** decimals()` against the deployed contract, because
that particular mismatch is silent and catastrophic.

---

## Integer arithmetic

No floating point touches a monetary value anywhere:

- **Browser** — `parseUsdToCents` parses the decimal string by hand. `Number("0.07") * 100` is
  `7.000000000000001`; there is a test asserting `parseUsdToCents("0.07") === 7n`. More than two
  decimal places is rejected, not rounded.
- **Attestor** — `bigint` only, with amounts arriving as decimal strings so JSON cannot round them.
  A JSON *number* where a string is expected is rejected outright, with a test for it.
- **Contract** — `uint256` with `Math.mulDiv(..., Math.Rounding.Ceil)`, which computes the full
  512-bit intermediate product and cannot overflow on the multiply.

For a 6-decimal stablecoin the conversion is exact — 10⁶ divides by 100 — so the ceiling never
engages in practice. It is there for a token with fewer than two decimals, which the deploy script
refuses anyway. Belt and braces.

---

## ERC-20 allowance risk

The frontend approves the **exact** amount required and never requests unlimited approval. Because
the amount cannot move, there is no slippage buffer left over — the approval is spent to the wei by
the funding call.

Standard caveats still apply: an approval is a standing authorisation until spent or revoked, and a
buyer who abandons a payment mid-flow leaves an allowance in place. All token movement uses
`SafeERC20`, so a non-standard token that returns `false` instead of reverting is still caught.

---

## Escrow state transitions

Every state-changing function:

1. Loads the invoice and rejects `None` (`InvoiceNotFound`).
2. Requires an exact expected status — not "anything but X".
3. Checks the caller against the specific role.
4. **Writes state before transferring tokens.**
5. Is `nonReentrant` where tokens move.
6. Is `whenNotPaused`.

Checks-effects-interactions is applied literally: in `fundInvoice`, `releasePayment`, `refundBuyer`
and `claimExpiredRefund`, status and `totalEscrowed` are updated and the event emitted *before*
`safeTransfer`/`safeTransferFrom`. A reentrant callback would find the invoice already terminal.

`claimExpiredRefund` additionally requires `block.timestamp > dueAt + refundGracePeriod`, so a
seller who delivered late still has a bounded window to be paid.

---

## No owner withdrawal path

There is no function by which the owner can move escrowed funds. `recoverUnsupportedToken` exists
for tokens accidentally sent to the contract and explicitly reverts for the settlement token.

`pause` can halt new activity but cannot redirect funds — and note that pausing **does** block
release and refund, so a malicious owner could freeze settlement. That is a griefing vector, not a
theft vector, and is another reason to put the owner behind a multisig.

---

## Data handling in the frontend and the attestor

- The plaintext payload exists only as a local `const` inside the creation function. It is never
  placed in React state, `localStorage`, a URL, a toast, or an error report.
- `nonce` and `salt` are generated inside the payload builder and dropped with it.
- Form state is reset after a successful creation.
- `ATTESTOR_PRIVATE_KEY` is server-only. `lib/attestor/signer.ts` imports `server-only`, so pulling
  it into a client component is a build error, not a silent leak into the bundle.
- `/api/attestor/info` returns only the public key, the signer address, the chain id and the escrow
  binding. All four are public by construction.
- The attestor never logs, persists or echoes plaintext. Validation errors name a field and a rule.
  There is a test asserting a rejected invoice's description does not appear in the error message.
- Decryption failures are uniform, so the endpoint cannot be used as an oracle.
- Request bodies are capped at 256 KB of hex, bounding the work an anonymous caller can cause.

---

## Remaining work before this could hold real value

1. **Third-party audit** of `BotSealEscrow.sol` and the attestor route.
2. **Attested execution** for the validator, with reproducible builds and a published code hash —
   the only thing that would turn the confidentiality claim from policy into a guarantee.
3. **Owner hardening** — multisig or timelock, with monitoring on `AttestorAddressUpdated` and
   `Paused`.
4. **Attestor key custody and rotation policy** — documented procedure, HSM or KMS rather than an
   environment variable.
5. **Rate limiting** on `/api/attestor/create`. It is currently unauthenticated and does real
   cryptographic work per request.
6. **Depeg policy** — what happens to an in-flight invoice if the settlement token loses its peg.
7. **Griefing review** — the pause-blocks-settlement path above.
8. **Formal verification** of the state machine and the cents → token-units conversion.
9. **Commitment revelation UX** — there is currently no in-app way for a seller to prove terms to a
   third party by revealing the payload, which is the feature the commitment exists to enable.
