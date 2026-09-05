/**
 * Attestor wire contract: the EIP-712 type, the request/response shapes, and browser-side
 * encryption.
 *
 * This module is imported by both the browser and the server route, so it must stay free of any
 * Node-only import. The signing key and the decryption live in `lib/attestor/signer.ts`, which is
 * server-only.
 *
 * What the attestor is: a server-side signing key operated by this project. It decrypts a private
 * invoice, recomputes every total, and signs only the settlement facts. It is NOT a TEE — there is
 * no hardware attestation, and an operator with server access can read the plaintext while it is
 * being validated. See docs/SECURITY.md.
 */

import type { Hex } from "viem";

// --- EIP-712 -----------------------------------------------------------------

export const EIP712_DOMAIN_NAME = "nimSeal";
export const EIP712_DOMAIN_VERSION = "1";

/**
 * Must match `CONFIDENTIAL_INVOICE_TYPEHASH` in NimSealEscrow.sol exactly, field for field and in
 * order. `hashConfidentialInvoice()` on the contract exists so this can be asserted rather than
 * assumed; `tests/attestor.test.ts` does exactly that.
 */
export const CONFIDENTIAL_INVOICE_TYPES = {
  ConfidentialInvoice: [
    { name: "seller", type: "address" },
    { name: "buyer", type: "address" },
    { name: "usdAmountCents", type: "uint256" },
    { name: "dueAt", type: "uint64" },
    { name: "termsCommitment", type: "bytes32" },
    { name: "attestationId", type: "bytes32" },
  ],
} as const;

/** The settlement facts the attestor signs. Mirrors the contract's `ConfidentialInvoice` struct. */
export interface ConfidentialAttestation {
  seller: Hex;
  buyer: Hex;
  usdAmountCents: bigint;
  dueAt: bigint;
  termsCommitment: Hex;
  attestationId: Hex;
}

/** JSON-safe form. `bigint` does not survive `JSON.stringify`, so amounts cross as strings. */
export interface SerialisedAttestation {
  seller: Hex;
  buyer: Hex;
  usdAmountCents: string;
  dueAt: string;
  termsCommitment: Hex;
  attestationId: Hex;
}

export function serialiseAttestation(a: ConfidentialAttestation): SerialisedAttestation {
  return {
    seller: a.seller,
    buyer: a.buyer,
    usdAmountCents: a.usdAmountCents.toString(),
    dueAt: a.dueAt.toString(),
    termsCommitment: a.termsCommitment,
    attestationId: a.attestationId,
  };
}

export function deserialiseAttestation(a: SerialisedAttestation): ConfidentialAttestation {
  return {
    seller: a.seller,
    buyer: a.buyer,
    usdAmountCents: BigInt(a.usdAmountCents),
    dueAt: BigInt(a.dueAt),
    termsCommitment: a.termsCommitment,
    attestationId: a.attestationId,
  };
}

export function domainFor(chainId: number, verifyingContract: Hex) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  } as const;
}

// --- /api/attestor/info ------------------------------------------------------

export interface AttestorInfo {
  /** Uncompressed secp256k1 public key, `0x04 || X || Y`, used as the ECIES recipient. */
  publicKey: Hex;
  /** The address the escrow verifies signatures against. */
  attestorAddress: Hex;
  /** Chain id the attestor is configured for, so the UI can warn on a mismatch. */
  chainId: number;
  /** The escrow this attestor will mint results for. */
  escrowContract: Hex;
}

// --- /api/attestor/create ----------------------------------------------------

export interface AttestorCreateRequest {
  /** ECIES ciphertext of the JSON `PrivateInvoicePayload`, encrypted to {@link AttestorInfo.publicKey}. */
  ciphertext: Hex;
}

export type AttestorCreateResponse =
  | { ok: true; attestation: SerialisedAttestation; signature: Hex }
  | { ok: false; error: string; message: string };

// --- Encryption --------------------------------------------------------------

/**
 * ECIES-encrypts the private invoice to the attestor's public key.
 *
 * Uses `ecies-geth`, the JavaScript port of go-ethereum's ECIES (`ECIES_AES128_SHA256` over
 * secp256k1) — the same scheme the server decrypts with. No cryptography is implemented here.
 *
 * The module is imported dynamically so its Node polyfills stay out of the server bundle.
 */
export async function encryptToAttestor(publicKey: Hex, plaintext: string): Promise<Hex> {
  const { encrypt } = await import("ecies-geth");
  const { Buffer } = await import("buffer");

  const key = Buffer.from(publicKey.slice(2), "hex");
  const message = Buffer.from(plaintext, "utf-8");

  const ciphertext = await encrypt(key, message);
  return `0x${Buffer.from(ciphertext).toString("hex")}` as Hex;
}
