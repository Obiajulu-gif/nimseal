# Demo runbook

Deterministic order, exact commands. Total time ~6 minutes once deployed.

---

## Before the demo

Two wallet accounts, both on the settlement chain (Polygon in production, Sepolia for rehearsal):

| Role | Needs |
|---|---|
| **Seller** | native gas (POL / Sepolia ETH) |
| **Buyer** | native gas **and** USDT |

They must be different addresses — the escrow reverts with `SameSellerAndBuyer` otherwise.

On Sepolia, gas comes from a Sepolia faucet and USDT from the mock you minted in
[deployment step 2](DEPLOYMENT.md#2-settlement-token). On Polygon, fund the wallets with POL and USDT.
For sealing, both accounts also need a Nimiq wallet in Nimiq Pay (use **Get free NIM** on testnet).

Pre-flight, in order:

```bash
node scripts/check-env.mjs
```

```bash
cd contracts && npm run smoke:sepolia
```

```bash
cd web && npm run check-attestor
```

The third is the one that matters. It exercises the confidential path for real — encrypt, decrypt,
validate, sign, recover — so if it passes, the demo will work. If it fails, fix it before you have
an audience.

Start the app:

```bash
cd web && npm run build && npm run start
```

---

## Act 1 — Create a confidential invoice (seller)

1. Open the app, connect the **seller** wallet. The header shows a green network badge (Polygon / Sepolia) and
   the deployment panel shows the escrow and settlement token addresses.

2. **New invoice**. Fill in:

   | Field | Value |
   |---|---|
   | Buyer | the buyer address |
   | Reference | `INV-2026-014` |
   | Due date | ~30 days out |
   | Item 1 | `Design retainer, March` · qty `2` · `1250.00` |
   | Item 2 | `Hosting, Q1` · qty `3` · `19.99` |
   | Tax | `50.25` |
   | Discount | `100.00` |

   The totals panel shows **$2,510.22** and `251022 cents`, computed as `255997 − 10000 + 5025`.
   Point out that it prints the raw cent count — this is integer arithmetic end to end, and the
   attestor is going to recompute this same number from the line items rather than take the
   browser's word for it.

3. **Create private invoice**. The progress panel walks the state machine:

   ```
   loading-attestor-info → encrypting → attesting
   → awaiting-wallet-signature → relaying-result → confirmed
   ```

   **One wallet confirmation.** Worth saying out loud: the previous version of this needed two, plus
   an indefinite wait while a proxy was polled.

4. You land on the invoice detail page.

5. **Seal with Nimiq wallet.** In the *Nimiq invoice seal* card, tap **Seal with Nimiq wallet** and
   confirm in Nimiq Pay. The card flips to **Sealed by NQ…** and a **Share payment link** button
   appears. That link carries the seal, so the buyer can verify it with no server.

**The point to make:** open the relay transaction on the explorer. The calldata is six fields and a
signature — parties, a cent total, a due date, and two 32-byte hashes. No description, no reference,
no quantities, no tax breakdown. Then open the escrow storage and show the same thing: there is
nowhere for the private terms to be, because there is no field for them.

---

## Act 2 — Fund and settle (buyer)

6. Open the shared payment link as the **buyer**. The **Nimiq verified · Sealed by NQ…** badge is
   green; expand it to show the address, public key, signature, and commitment. Point out the
   verification is client-side — the address is derived from the key, not read from the link.

7. Connect the **buyer** wallet. Click **Fund this invoice** (or go to `/pay/<id>`). The page shows
   the required USDT, the buyer's balance, and the current allowance.

   Note what is *not* there: no price, no slippage selector, no "quote expires in" countdown. The
   amount was fixed when the invoice was created and cannot move.

8. **Approve USDT** — it approves the exact amount, not unlimited. Because the amount cannot change,
   there is no buffer left over afterwards.

9. **Fund escrow**. The contract recomputes the figure from the invoice's stored cent total and
   transfers exactly that. The page supplies no amount at all.

10. **Release payment to seller**. Status → **Released**.

11. Confirm the seller's USDT balance increased, in the wallet or the explorer.

---

## Talking points

**Privacy is structural, not promised.** The escrow has no field for a description. There is no
"private" flag to get wrong — the data was never submitted.

**The attestor is authoritative, not trusted with money.** It validates and signs; the escrow
verifies the signature, rejects replays, and enforces who may fund, release and refund. A
compromised attestor key can fabricate invoices nobody has to pay — it cannot move escrowed USDT.

**Be straight about the trust model.** If someone asks whether we can read the invoice: yes, during
validation. It is a server key, not an enclave. Saying so is better than being caught implying
otherwise, and [SECURITY.md](SECURITY.md) says exactly what would have to change.

**Nothing to manipulate on price.** A USD invoice settled in a USD stablecoin needs no oracle, so
there is no feed to attack, no staleness window, and no way for a buyer to influence what they pay.
The tradeoff is depeg risk, which is visible to both parties.

**Replay is prevented on-chain.** Relay the same attestation twice and it reverts with
`AttestationAlreadyConsumed`. There is a contract test for it, and for the fact that a *failed*
relay does not consume the id.

---

## If the attestor is down

1. Set `NEXT_PUBLIC_ENABLE_PUBLIC_MODE=true` and restart the frontend.
2. Use **Create public fallback invoice**. Every such invoice is labelled **Public fallback** in the
   UI and its attestation id is empty.
3. The USDT half of the demo — quote, approve, fund, release — is unaffected and real.

Say plainly that the confidential path is the point and this is a continuity measure. Do not present
a public invoice as a confidential one.

The most likely cause is an unset or malformed `ATTESTOR_PRIVATE_KEY`, which surfaces as a 503 from
`/api/attestor/info` with the reason in the message.

---

## Reset between runs

Invoices are append-only; nothing needs resetting. For a clean dashboard use a fresh seller address,
or note that `nextInvoiceId` keeps counting.
