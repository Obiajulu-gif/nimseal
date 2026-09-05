/**
 * The Nimiq Invoice Seal: canonical message, address derivation, and signature verification.
 *
 * When a seller creates a confidential invoice they sign a canonical statement binding the invoice
 * to their Nimiq identity, through Nimiq Pay. The buyer can then verify — with no trusted server —
 * that the invoice on-chain was sealed by a specific Nimiq wallet:
 *
 *   1. reconstruct the exact signed message from public on-chain facts (chain, escrow, invoice id,
 *      commitment, amount, due date),
 *   2. verify the Ed25519 signature against the seller's Nimiq public key,
 *   3. derive the Nimiq address from that public key and show it as `NQ… `.
 *
 * Nimiq message signing (per the Nimiq Hub / core `signMessage`): the string is prefixed with
 * `"\x16Nimiq Signed Message:\n"`, then the message length, then the message; that buffer is
 * SHA-256 hashed, and the 32-byte hash is what Ed25519 signs. This module reproduces that exactly.
 */

import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import * as ed25519 from "@noble/ed25519";

// @noble/ed25519 v2 needs a SHA-512 implementation wired in for verification. Do it once, here.
if (!ed25519.etc.sha512Sync) {
  ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));
}

// --- Canonical seal message --------------------------------------------------

export const SEAL_DOMAIN = "BotSeal Invoice Seal";
export const SEAL_VERSION = 1;

export interface SealSubject {
  chainId: number;
  /** Escrow contract address (any casing; normalised to lowercase). */
  escrow: string;
  invoiceId: bigint;
  /** 32-byte terms commitment, `0x…`. */
  termsCommitment: string;
  usdAmountCents: bigint;
  /** Unix seconds. */
  dueAt: bigint;
}

/**
 * Builds the exact ASCII string the seller signs and the buyer verifies.
 *
 * Every field is public on-chain state, so the buyer can reconstruct this verbatim from the invoice
 * record plus the app's configured chain and escrow. Kept ASCII-only so the byte length used in the
 * Nimiq signing prefix is unambiguous.
 */
export function buildSealMessage(subject: SealSubject): string {
  return [
    `${SEAL_DOMAIN} v${SEAL_VERSION}`,
    `chain:${subject.chainId}`,
    `escrow:${subject.escrow.toLowerCase()}`,
    `invoice:${subject.invoiceId.toString()}`,
    `commitment:${subject.termsCommitment.toLowerCase()}`,
    `amount:${subject.usdAmountCents.toString()}`,
    `due:${subject.dueAt.toString()}`,
  ].join("\n");
}

// --- Nimiq signed-message hash -----------------------------------------------

const SIGN_PREFIX = "\x16Nimiq Signed Message:\n";

/** Reproduces Nimiq's message hash: `SHA256(prefix + byteLength + message)`. */
export function nimiqMessageHash(message: string): Uint8Array {
  const messageBytes = utf8(message);
  const data = utf8(SIGN_PREFIX + messageBytes.length) ;
  const buffer = new Uint8Array(data.length + messageBytes.length);
  buffer.set(data, 0);
  buffer.set(messageBytes, data.length);
  return sha256(buffer);
}

// --- Signature verification --------------------------------------------------

export interface SealProof {
  /** Ed25519 public key, 32 bytes, hex (with or without 0x). */
  publicKey: string;
  /** Ed25519 signature, 64 bytes, hex (with or without 0x). */
  signature: string;
}

/**
 * Verifies that {proof} is a valid Nimiq signature over the canonical message for {subject}.
 * Returns the signer's Nimiq address on success, or `undefined` if verification fails for any
 * reason (bad hex, wrong length, invalid signature).
 */
export function verifySeal(subject: SealSubject, proof: SealProof): string | undefined {
  try {
    const publicKey = fromHex(proof.publicKey);
    const signature = fromHex(proof.signature);
    if (publicKey.length !== 32 || signature.length !== 64) return undefined;

    const hash = nimiqMessageHash(buildSealMessage(subject));
    if (!ed25519.verify(signature, hash, publicKey)) return undefined;

    return publicKeyToAddress(publicKey);
  } catch {
    return undefined;
  }
}

// --- Nimiq address derivation ------------------------------------------------

const BASE32_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVXY";

/** Derives the user-friendly Nimiq address (`NQ… `) from an Ed25519 public key given as hex. */
export function publicKeyHexToAddress(publicKeyHex: string): string {
  return publicKeyToAddress(fromHex(publicKeyHex));
}

/** Derives the user-friendly Nimiq address (`NQ… `) from a 32-byte Ed25519 public key. */
export function publicKeyToAddress(publicKey: Uint8Array): string {
  const hash = sha256(publicKey);
  const addressBytes = hash.slice(0, 20);
  const base32 = base32Encode(addressBytes);
  const check = ("00" + (98 - ibanCheck(base32 + "NQ00"))).slice(-2);
  const full = "NQ" + check + base32;
  return full.replace(/.{4}/g, "$& ").trim();
}

/** Base32 encode exactly, using the Nimiq alphabet. Input length must be a multiple of 5 bits' worth. */
function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** The IBAN mod-97 remainder used by Nimiq's address checksum. */
function ibanCheck(str: string): number {
  const num = str
    .split("")
    .map((c) => {
      const code = c.toUpperCase().charCodeAt(0);
      return code >= 48 && code <= 57 ? c : (code - 55).toString();
    })
    .join("");
  let tmp = "";
  for (let i = 0; i < Math.ceil(num.length / 6); i++) {
    tmp = (parseInt(tmp + num.substr(i * 6, 6), 10) % 97).toString();
  }
  return parseInt(tmp, 10);
}

/** Compact `NQAB…WXYZ` form for display. */
export function shortenNimiqAddress(address: string): string {
  const compact = address.replace(/\s+/g, "");
  if (compact.length <= 12) return address;
  return `${compact.slice(0, 6)}…${compact.slice(-4)}`;
}

// --- Seal transport (self-contained payment links) ---------------------------

export interface EncodedSeal {
  v: number;
  pk: string;
  sig: string;
  /** Signer address, cached for display; always re-derived and re-checked on verify. */
  nq: string;
}

/** Encodes a seal proof for a payment link query parameter (base64url of compact JSON). */
export function encodeSeal(proof: SealProof, address: string): string {
  const payload: EncodedSeal = {
    v: SEAL_VERSION,
    pk: strip0x(proof.publicKey),
    sig: strip0x(proof.signature),
    nq: address.replace(/\s+/g, ""),
  };
  return base64UrlEncode(JSON.stringify(payload));
}

/** Decodes a seal proof from a payment-link parameter, or `undefined` if malformed. */
export function decodeSeal(param: string): EncodedSeal | undefined {
  try {
    const parsed = JSON.parse(base64UrlDecode(param)) as EncodedSeal;
    if (typeof parsed?.pk !== "string" || typeof parsed?.sig !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

// --- Small encoders (dependency-free, WebView-safe) --------------------------

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function fromHex(hex: string): Uint8Array {
  const clean = strip0x(hex).trim();
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64UrlEncode(s: string): string {
  const b64 = typeof btoa !== "undefined" ? btoa(s) : Buffer.from(s, "utf-8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return typeof atob !== "undefined"
    ? atob(b64)
    : Buffer.from(b64, "base64").toString("utf-8");
}
