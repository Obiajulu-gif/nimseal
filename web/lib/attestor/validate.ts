/**
 * Invoice validation, integer-cent arithmetic, and the deterministic terms commitment.
 *
 * This is the authoritative recomputation. The browser mirrors these bounds for UX, but nothing the
 * browser computes is trusted: every total here is derived from the decrypted payload, and the
 * signature the escrow accepts covers only what this module returns.
 *
 * Nothing in this module may log, echo, or otherwise export the plaintext — errors name the field
 * and the rule that failed, never the offending value, because the message is returned to the
 * caller.
 *
 * All money is integer cents as `bigint`. There is no floating point anywhere in this file, and
 * numeric fields arrive as decimal strings precisely so JSON parsing cannot round them.
 */

import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  toHex,
  type Hex,
} from "viem";

import {
  MAX_DESCRIPTION_LENGTH,
  MAX_DUE_DATE_HORIZON_SECONDS,
  MAX_ITEMS,
  MAX_QUANTITY,
  MAX_REFERENCE_LENGTH,
  MAX_TOTAL_CENTS,
  MIN_ITEMS,
  MIN_QUANTITY,
  MIN_SECRET_LENGTH,
  type PrivateInvoicePayload,
} from "@/lib/invoice";

/** Domain tag mixed into every terms commitment. Changing it invalidates old commitments. */
export const COMMITMENT_DOMAIN = "NIMSEAL_INVOICE_V1";

export interface ValidatedInvoice {
  seller: Hex;
  buyer: Hex;
  escrowContract: Hex;
  subtotalCents: bigint;
  discountCents: bigint;
  taxCents: bigint;
  finalTotalCents: bigint;
  dueAt: bigint;
  termsCommitment: Hex;
}

export class InvoiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceValidationError";
  }
}

function fail(message: string): never {
  throw new InvoiceValidationError(message);
}

// --- Primitive parsing -------------------------------------------------------

/** Parses a non-negative integer supplied as a decimal string. Rejects anything else. */
function parseUintString(value: unknown, field: string): bigint {
  if (typeof value !== "string") fail(`${field} must be a decimal string`);
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    fail(`${field} must be a non-negative integer without leading zeros or separators`);
  }
  // 30 digits is far beyond any legitimate cent amount and keeps the value away from uint256
  // overflow territory before the range checks below run.
  if (value.length > 30) fail(`${field} exceeds the maximum supported magnitude`);
  return BigInt(value);
}

function requireAddress(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !isAddress(value)) {
    fail(`${field} must be a valid EVM address`);
  }
  // Checksum-normalise so commitments are stable regardless of the caller's casing.
  return getAddress(value) as Hex;
}

function requireString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  if (value.length < min || value.length > max) {
    fail(`${field} length must be between ${min} and ${max} characters`);
  }
  return value;
}

// --- Validation --------------------------------------------------------------

export interface ValidateOptions {
  /** The escrow address this attestor is bound to. */
  expectedEscrow: string;
  /** Current unix time in seconds. Injected so tests are deterministic. */
  nowSeconds: number;
}

export function validateInvoice(raw: unknown, options: ValidateOptions): ValidatedInvoice {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("payload must be a JSON object");
  }
  const payload = raw as Partial<PrivateInvoicePayload>;

  if (payload.version !== 1) fail("version must be 1");
  if (payload.currency !== "USD") fail("currency must be USD");

  const seller = requireAddress(payload.seller, "seller");
  const buyer = requireAddress(payload.buyer, "buyer");
  const escrowContract = requireAddress(payload.escrowContract, "escrowContract");

  if (seller.toLowerCase() === buyer.toLowerCase()) {
    fail("seller and buyer must be different addresses");
  }

  if (!isAddress(options.expectedEscrow)) {
    fail("attestor is not configured with a valid escrow address");
  }
  if (escrowContract.toLowerCase() !== getAddress(options.expectedEscrow).toLowerCase()) {
    fail("escrowContract does not match this attestor's configured escrow");
  }

  const invoiceReference = requireString(
    payload.invoiceReference,
    "invoiceReference",
    1,
    MAX_REFERENCE_LENGTH,
  );

  if (typeof payload.dueAt !== "number" || !Number.isSafeInteger(payload.dueAt)) {
    fail("dueAt must be an integer unix timestamp in seconds");
  }
  if (payload.dueAt <= options.nowSeconds) fail("dueAt must be in the future");
  if (payload.dueAt > options.nowSeconds + MAX_DUE_DATE_HORIZON_SECONDS) {
    fail("dueAt must be no more than 366 days in the future");
  }

  if (!Array.isArray(payload.items)) fail("items must be an array");
  if (payload.items.length < MIN_ITEMS) fail("items must contain at least one entry");
  if (payload.items.length > MAX_ITEMS) fail(`items must contain at most ${MAX_ITEMS} entries`);

  const nonce = requireString(payload.nonce, "nonce", MIN_SECRET_LENGTH, 256);
  const salt = requireString(payload.salt, "salt", MIN_SECRET_LENGTH, 256);

  // --- Line items: exact integer arithmetic ---
  const itemHashes: Hex[] = [];
  let subtotalCents = 0n;

  for (let i = 0; i < payload.items.length; i++) {
    const item = payload.items[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      fail(`items[${i}] must be an object`);
    }

    const description = requireString(
      item.description,
      `items[${i}].description`,
      1,
      MAX_DESCRIPTION_LENGTH,
    );

    const quantity = parseUintString(item.quantity, `items[${i}].quantity`);
    if (quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) {
      fail(`items[${i}].quantity must be between ${MIN_QUANTITY} and ${MAX_QUANTITY}`);
    }

    const unitPriceCents = parseUintString(item.unitPriceCents, `items[${i}].unitPriceCents`);
    if (unitPriceCents <= 0n) fail(`items[${i}].unitPriceCents must be greater than zero`);

    const lineTotal = quantity * unitPriceCents;
    subtotalCents += lineTotal;

    itemHashes.push(hashItem(description, quantity, unitPriceCents, lineTotal));
  }

  const discountCents = parseUintString(payload.discountCents, "discountCents");
  const taxCents = parseUintString(payload.taxCents, "taxCents");

  if (discountCents > subtotalCents) fail("discountCents cannot exceed the subtotal");

  const finalTotalCents = subtotalCents - discountCents + taxCents;
  if (finalTotalCents <= 0n) fail("invoice total must be greater than zero");
  if (finalTotalCents > MAX_TOTAL_CENTS) fail("invoice total exceeds the configured maximum");

  const dueAt = BigInt(payload.dueAt);

  const termsCommitment = computeTermsCommitment({
    seller,
    buyer,
    escrowContract,
    invoiceReference,
    itemHashes,
    discountCents,
    taxCents,
    finalTotalCents,
    dueAt,
    nonce,
    salt,
  });

  return {
    seller,
    buyer,
    escrowContract,
    subtotalCents,
    discountCents,
    taxCents,
    finalTotalCents,
    dueAt,
    termsCommitment,
  };
}

// --- Commitment --------------------------------------------------------------

function hashItem(
  description: string,
  quantity: bigint,
  unitPriceCents: bigint,
  lineTotal: bigint,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [keccak256(toHex(description)), quantity, unitPriceCents, lineTotal],
    ),
  );
}

/** keccak256 over the concatenated per-item hashes, in submission order. */
export function hashItems(itemHashes: Hex[]): Hex {
  const concatenated = `0x${itemHashes.map((h) => h.slice(2)).join("")}` as Hex;
  return keccak256(concatenated);
}

export interface CommitmentInput {
  seller: Hex;
  buyer: Hex;
  escrowContract: Hex;
  invoiceReference: string;
  itemHashes: Hex[];
  discountCents: bigint;
  taxCents: bigint;
  finalTotalCents: bigint;
  dueAt: bigint;
  nonce: string;
  salt: string;
}

/**
 * Binds every private term to a single 32-byte value that is safe to publish on-chain.
 *
 * The commitment is deterministic: the same normalised inputs always produce the same value, so a
 * seller can later prove exactly what was invoiced by revealing the payload. It is also hiding:
 * `nonce` and `salt` are 32 bytes of browser-generated entropy each, so the commitment cannot be
 * brute-forced back to the line items.
 */
export function computeTermsCommitment(input: CommitmentInput): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, // domain
        { type: "address" }, // seller
        { type: "address" }, // buyer
        { type: "address" }, // escrowContract
        { type: "bytes32" }, // keccak(invoiceReference)
        { type: "bytes32" }, // itemsHash
        { type: "uint256" }, // discountCents
        { type: "uint256" }, // taxCents
        { type: "uint256" }, // finalTotalCents
        { type: "uint64" }, //  dueAt
        { type: "bytes32" }, // keccak(nonce)
        { type: "bytes32" }, // keccak(salt)
      ],
      [
        keccak256(toHex(COMMITMENT_DOMAIN)),
        input.seller,
        input.buyer,
        input.escrowContract,
        keccak256(toHex(input.invoiceReference)),
        hashItems(input.itemHashes),
        input.discountCents,
        input.taxCents,
        input.finalTotalCents,
        input.dueAt,
        keccak256(toHex(input.nonce)),
        keccak256(toHex(input.salt)),
      ],
    ),
  );
}

/**
 * Derives the single-use attestation id from the commitment.
 *
 * Deterministic on purpose. Two invoices with identical terms still differ here, because the
 * commitment mixes in per-invoice `nonce` and `salt` entropy. What determinism buys is idempotency:
 * a seller who submits the same invoice twice gets the same id, and the escrow's replay guard turns
 * the second relay into `AttestationAlreadyConsumed` instead of a duplicate invoice.
 */
export function deriveAttestationId(termsCommitment: Hex, seller: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }],
      [termsCommitment, seller],
    ),
  );
}
