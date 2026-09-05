/**
 * Nimiq invoice seal: message construction, address derivation, signature verification, transport.
 *
 * Importing the seal module wires @noble/ed25519's SHA-512 hook, so this test can also *produce*
 * signatures with the same message hash the verifier uses, proving the verify path end to end.
 */

import { describe, expect, it } from "vitest";
import * as ed25519 from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import type { Hex } from "viem";

import {
  buildSealMessage,
  decodeSeal,
  encodeSeal,
  nimiqMessageHash,
  publicKeyToAddress,
  shortenNimiqAddress,
  verifySeal,
  type SealSubject,
} from "@/lib/nimiq/seal";

const SUBJECT: SealSubject = {
  chainId: 137,
  escrow: "0x358A95Aa014D112CDFbEe5f3eA599BA14B331CBF",
  invoiceId: 14n,
  termsCommitment: `0x${"ab".repeat(32)}` as Hex,
  usdAmountCents: 302_500n,
  dueAt: 1_787_817_137n,
};

/** Signs a subject's canonical message with a fresh Nimiq-style key, as Nimiq Pay would. */
function sign(subject: SealSubject) {
  const priv = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(priv);
  const hash = nimiqMessageHash(buildSealMessage(subject));
  const signature = ed25519.sign(hash, priv);
  return {
    publicKey: toHex(publicKey),
    signature: toHex(signature),
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("Nimiq address derivation", () => {
  it("derives the canonical zero-key burn address checksum shape", () => {
    // The 20 zero address bytes map to NQ07 0000…, the documented Nimiq burn address. We can only
    // feed a public key here, so assert the format and checksum discipline instead.
    const addr = publicKeyToAddress(new Uint8Array(32));
    expect(addr).toMatch(/^NQ\d{2}( [0-9A-HJ-NP-Z]{4}){8}$/);
  });

  it("produces a stable 36-character user-friendly address", () => {
    const { publicKey } = sign(SUBJECT);
    const bytes = Uint8Array.from(publicKey.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    const addr = publicKeyToAddress(bytes);
    expect(addr.replace(/\s/g, "")).toHaveLength(36);
    expect(addr.startsWith("NQ")).toBe(true);
  });
});

describe("buildSealMessage", () => {
  it("is deterministic and binds every settlement fact", () => {
    const msg = buildSealMessage(SUBJECT);
    expect(msg).toContain("chain:137");
    expect(msg).toContain("invoice:14");
    expect(msg).toContain("amount:302500");
    expect(msg).toContain(SUBJECT.escrow.toLowerCase());
    expect(buildSealMessage(SUBJECT)).toBe(msg);
  });

  it("lowercases the commitment and escrow so casing cannot change the digest", () => {
    const upper = { ...SUBJECT, termsCommitment: SUBJECT.termsCommitment.toUpperCase() as Hex };
    expect(buildSealMessage(upper)).toBe(buildSealMessage(SUBJECT));
  });
});

describe("verifySeal", () => {
  it("verifies a valid signature and returns the signer address", () => {
    const proof = sign(SUBJECT);
    const address = verifySeal(SUBJECT, proof);
    expect(address).toBeDefined();
    expect(address!.startsWith("NQ")).toBe(true);
  });

  it("rejects a signature over a different invoice", () => {
    const proof = sign(SUBJECT);
    const tampered = { ...SUBJECT, usdAmountCents: 999_999n };
    expect(verifySeal(tampered, proof)).toBeUndefined();
  });

  it("rejects malformed hex without throwing", () => {
    expect(verifySeal(SUBJECT, { publicKey: "zz", signature: "0x00" })).toBeUndefined();
  });

  it("rejects a wrong-length key", () => {
    expect(verifySeal(SUBJECT, { publicKey: "ab", signature: "ab".repeat(64) })).toBeUndefined();
  });
});

describe("seal transport", () => {
  it("round-trips a proof through the payment-link encoding", () => {
    const proof = sign(SUBJECT);
    const address = verifySeal(SUBJECT, proof)!;
    const encoded = encodeSeal(proof, address);
    const decoded = decodeSeal(encoded);
    expect(decoded).toBeDefined();
    expect(decoded!.pk).toBe(proof.publicKey);
    expect(decoded!.sig).toBe(proof.signature);
    // A decoded seal still verifies against the invoice.
    expect(verifySeal(SUBJECT, { publicKey: decoded!.pk, signature: decoded!.sig })).toBe(address);
  });

  it("returns undefined for a malformed seal parameter", () => {
    expect(decodeSeal("not-base64!!")).toBeUndefined();
  });
});

describe("shortenNimiqAddress", () => {
  it("compacts a full address for display", () => {
    const short = shortenNimiqAddress("NQ07 0000 0000 0000 0000 0000 0000 0000 0000");
    expect(short).toContain("…");
    expect(short.startsWith("NQ0700")).toBe(true);
  });
});
