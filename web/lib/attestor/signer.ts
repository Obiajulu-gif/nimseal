import "server-only";

/**
 * Server-only attestor key handling: decryption and EIP-712 signing.
 *
 * The private key is read from `ATTESTOR_PRIVATE_KEY`, which must never be prefixed
 * `NEXT_PUBLIC_` — that would inline it into the browser bundle. The `server-only` import above
 * turns any accidental client import of this module into a build error rather than a leak.
 *
 * This key is the whole trust assumption of the confidential path. Whoever holds it can mint
 * settlement facts the escrow will accept, and can read any invoice submitted to this service.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Hex, PrivateKeyAccount } from "viem";

import {
  CONFIDENTIAL_INVOICE_TYPES,
  domainFor,
  type ConfidentialAttestation,
} from "@/lib/attestor";
import { env } from "@/lib/env";

let cached: PrivateKeyAccount | undefined;

/** Loads the attestor account, or throws with a message safe to surface to the caller. */
export function attestorAccount(): PrivateKeyAccount {
  if (cached) return cached;

  const raw = process.env.ATTESTOR_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error("ATTESTOR_PRIVATE_KEY is not set. The confidential path is unavailable.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("ATTESTOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.");
  }

  cached = privateKeyToAccount(raw as Hex);
  return cached;
}

/** The escrow this attestor mints results for. Server-side so it can be rotated without a rebuild. */
export function configuredEscrow(): Hex {
  const raw =
    process.env.ATTESTOR_ESCROW_ADDRESS?.trim() ||
    process.env.NEXT_PUBLIC_ESCROW_ADDRESS?.trim();
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(
      "No escrow address configured. Set ATTESTOR_ESCROW_ADDRESS (or NEXT_PUBLIC_ESCROW_ADDRESS).",
    );
  }
  return raw as Hex;
}

/**
 * The chain the attestor binds its EIP-712 domain to. This MUST equal the escrow's chain, or every
 * signature is rejected on-chain. It comes from the same validated source as the rest of the app
 * (NEXT_PUBLIC_EVM_CHAIN_ID, restricted to Polygon/Sepolia) — never a hardcoded fallback.
 */
export function configuredChainId(): number {
  return env.chainId;
}

/**
 * ECIES-decrypts a ciphertext produced by `encryptToAttestor`.
 *
 * Failure is deliberately opaque: a decryption error tells the caller only that the payload could
 * not be decrypted, never why, because the difference between "wrong key" and "malformed
 * ciphertext" is an oracle worth denying.
 */
export async function decryptToText(ciphertext: Hex): Promise<string> {
  const { decrypt } = await import("ecies-geth");
  const { Buffer } = await import("buffer");

  const account = attestorAccount();
  const key = Buffer.from(process.env.ATTESTOR_PRIVATE_KEY!.trim().slice(2), "hex");
  void account; // ensures the key was validated before use

  const plaintext = await decrypt(key, Buffer.from(ciphertext.slice(2), "hex"));
  return Buffer.from(plaintext).toString("utf-8");
}

/** Signs the settlement facts with the EIP-712 domain the escrow verifies against. */
export async function signAttestation(
  attestation: ConfidentialAttestation,
): Promise<Hex> {
  const account = attestorAccount();

  return account.signTypedData({
    domain: domainFor(configuredChainId(), configuredEscrow()),
    types: CONFIDENTIAL_INVOICE_TYPES,
    primaryType: "ConfidentialInvoice",
    message: attestation,
  });
}
