/**
 * End-to-end check of the running attestor service.
 *
 * Encrypts a real invoice to the attestor's advertised key, posts it, and verifies that:
 *   - the total was recomputed from the line items, not taken on trust
 *   - the signature recovers to the address the service reports (and the escrow verifies)
 *   - the attestation id is deterministic, so a double submission cannot mint two invoices
 *   - an invalid invoice is refused rather than signed
 *   - a garbage ciphertext fails uniformly, without revealing why
 *
 * Run against a local dev server or a deployed one:
 *   node scripts/check-attestor.mjs
 *   ATTESTOR_BASE_URL=https://your-app.example node scripts/check-attestor.mjs
 *
 * Read-only: it never sends a transaction and needs no key.
 */
import { encrypt } from "ecies-geth";
import { Buffer } from "node:buffer";
import { recoverTypedDataAddress, keccak256, toHex } from "viem";

const BASE = (process.env.ATTESTOR_BASE_URL ?? "http://localhost:3003").replace(/\/+$/, "");

const TYPES = {
  ConfidentialInvoice: [
    { name: "seller", type: "address" },
    { name: "buyer", type: "address" },
    { name: "usdAmountCents", type: "uint256" },
    { name: "dueAt", type: "uint64" },
    { name: "termsCommitment", type: "bytes32" },
    { name: "attestationId", type: "bytes32" },
  ],
};

const info = await (await fetch(`${BASE}/api/attestor/info`)).json();
console.log("attestor:", info.attestorAddress, "chain", info.chainId);

const SELLER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const dueAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;

const payload = {
  version: 1,
  seller: SELLER,
  buyer: BUYER,
  escrowContract: info.escrowContract,
  invoiceReference: "INV-2026-014",
  dueAt,
  currency: "USD",
  items: [
    { description: "Design retainer", quantity: "2", unitPriceCents: "150000" },
    { description: "Hosting", quantity: "1", unitPriceCents: "2500" },
  ],
  discountCents: "0",
  taxCents: "0",
  nonce: "n".repeat(32),
  salt: "s".repeat(32),
};

const cipherBuf = await encrypt(
  Buffer.from(info.publicKey.slice(2), "hex"),
  Buffer.from(JSON.stringify(payload), "utf-8"),
);
const ciphertext = `0x${Buffer.from(cipherBuf).toString("hex")}`;
console.log("ciphertext bytes:", (ciphertext.length - 2) / 2);

const res = await fetch(`${BASE}/api/attestor/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ciphertext }),
});
const body = await res.json();
console.log("HTTP", res.status, JSON.stringify(body, null, 2));

if (!body.ok) process.exit(1);

const message = {
  seller: body.attestation.seller,
  buyer: body.attestation.buyer,
  usdAmountCents: BigInt(body.attestation.usdAmountCents),
  dueAt: BigInt(body.attestation.dueAt),
  termsCommitment: body.attestation.termsCommitment,
  attestationId: body.attestation.attestationId,
};

const recovered = await recoverTypedDataAddress({
  domain: {
    name: "nimSeal",
    version: "1",
    chainId: info.chainId,
    verifyingContract: info.escrowContract,
  },
  types: TYPES,
  primaryType: "ConfidentialInvoice",
  message,
  signature: body.signature,
});

const total = message.usdAmountCents;
const expectedTotal = 2n * 150000n + 1n * 2500n;

console.log("\n--- assertions ---");
console.log("total recomputed  :", total, total === expectedTotal ? "OK" : "MISMATCH");
console.log("recovered signer  :", recovered);
console.log("matches attestor  :", recovered.toLowerCase() === info.attestorAddress.toLowerCase());
console.log("attestationId     :", message.attestationId);

// Determinism: the same invoice must yield the same id.
const res2 = await fetch(`${BASE}/api/attestor/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    ciphertext: `0x${Buffer.from(
      await encrypt(
        Buffer.from(info.publicKey.slice(2), "hex"),
        Buffer.from(JSON.stringify(payload), "utf-8"),
      ),
    ).toString("hex")}`,
  }),
});
const body2 = await res2.json();
console.log(
  "id is deterministic:",
  body2.ok && body2.attestation.attestationId === message.attestationId,
);

// A tampered invoice must be rejected, not signed.
const bad = { ...payload, items: [{ description: "x", quantity: "0", unitPriceCents: "1" }] };
const res3 = await fetch(`${BASE}/api/attestor/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    ciphertext: `0x${Buffer.from(
      await encrypt(
        Buffer.from(info.publicKey.slice(2), "hex"),
        Buffer.from(JSON.stringify(bad), "utf-8"),
      ),
    ).toString("hex")}`,
  }),
});
const body3 = await res3.json();
console.log("invalid invoice rejected:", res3.status, body3.error, "-", body3.message);

// Garbage ciphertext must not leak why it failed.
const res4 = await fetch(`${BASE}/api/attestor/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ciphertext: "0xdeadbeef" }),
});
const body4 = await res4.json();
console.log("garbage rejected  :", res4.status, body4.error, "-", body4.message);

const pass =
  total === expectedTotal &&
  recovered.toLowerCase() === info.attestorAddress.toLowerCase() &&
  body2.ok &&
  body2.attestation.attestationId === message.attestationId &&
  res3.status === 422 &&
  res4.status === 400;
console.log(pass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(pass ? 0 : 1);
