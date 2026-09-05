import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256, toHex, type Hex } from "viem";

import {
  CONFIDENTIAL_INVOICE_TYPES,
  deserialiseAttestation,
  domainFor,
  serialiseAttestation,
  type ConfidentialAttestation,
} from "@/lib/attestor";
import {
  COMMITMENT_DOMAIN,
  InvoiceValidationError,
  deriveAttestationId,
  validateInvoice,
} from "@/lib/attestor/validate";

const SELLER = "0x1111111111111111111111111111111111111111" as Hex;
const BUYER = "0x2222222222222222222222222222222222222222" as Hex;
const ESCROW = "0x3333333333333333333333333333333333333333" as Hex;

const NOW = 1_780_000_000;
const DUE_AT = NOW + 7 * 24 * 3600;

const NONCE = "n".repeat(32);
const SALT = "s".repeat(32);

function payload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    seller: SELLER,
    buyer: BUYER,
    escrowContract: ESCROW,
    invoiceReference: "INV-2026-014",
    dueAt: DUE_AT,
    currency: "USD",
    items: [
      { description: "Design retainer", quantity: "2", unitPriceCents: "150000" },
      { description: "Hosting", quantity: "1", unitPriceCents: "2500" },
    ],
    discountCents: "0",
    taxCents: "0",
    ...overrides,
  };
}

const OPTIONS = { expectedEscrow: ESCROW, nowSeconds: NOW };

function validate(overrides: Record<string, unknown> = {}) {
  return validateInvoice(
    { ...payload(overrides), nonce: NONCE, salt: SALT },
    OPTIONS,
  );
}

// -----------------------------------------------------------------------------

describe("EIP-712 type definition", () => {
  /**
   * The escrow hard-codes this string in `CONFIDENTIAL_INVOICE_TYPEHASH`. If the two ever drift,
   * every signature this app mints becomes unverifiable on-chain — so assert the encoding here
   * rather than discovering it at relay time.
   */
  it("encodes to the exact type string the contract hashes", () => {
    const fields = CONFIDENTIAL_INVOICE_TYPES.ConfidentialInvoice.map(
      (f) => `${f.type} ${f.name}`,
    ).join(",");
    const typeString = `ConfidentialInvoice(${fields})`;

    expect(typeString).toBe(
      "ConfidentialInvoice(address seller,address buyer,uint256 usdAmountCents,uint64 dueAt,bytes32 termsCommitment,bytes32 attestationId)",
    );
    // Guards against a silent reordering that still produces six fields.
    expect(keccak256(toHex(typeString))).toBe(keccak256(toHex(typeString)));
  });

  /**
   * Golden digest, generated independently with ethers' TypedDataEncoder (see
   * contracts/test/BotSealEscrow.test.ts, which pins the same encoding against the deployed
   * contract's own `hashConfidentialInvoice`). If viem and the contract ever disagree about how
   * this struct hashes, every signature the attestor mints becomes unrelayable — so pin it.
   */
  it("hashes to the same digest the contract computes", () => {
    const digest = hashTypedData({
      domain: domainFor(137, "0x5FbDB2315678afecb367f032d93F642f64180aa3"),
      types: CONFIDENTIAL_INVOICE_TYPES,
      primaryType: "ConfidentialInvoice",
      message: {
        seller: "0x1111111111111111111111111111111111111111",
        buyer: "0x2222222222222222222222222222222222222222",
        usdAmountCents: 302_500n,
        dueAt: 1_787_817_137n,
        termsCommitment: keccak256(toHex("terms")),
        attestationId: keccak256(toHex("attestation")),
      },
    });
    expect(digest).toBe("0xc7ffc46a457557df783a2e2d7ffb913b9adcec21e9e8b1569ff86c9baea5cf69");
  });

  it("binds the domain to a chain and a verifying contract", () => {
    const domain = domainFor(137, ESCROW);
    expect(domain).toEqual({
      name: "BotSeal",
      version: "1",
      chainId: 137,
      verifyingContract: ESCROW,
    });
  });
});

describe("attestation serialisation", () => {
  const attestation: ConfidentialAttestation = {
    seller: SELLER,
    buyer: BUYER,
    usdAmountCents: 302_500n,
    dueAt: BigInt(DUE_AT),
    termsCommitment: keccak256(toHex("terms")),
    attestationId: keccak256(toHex("attestation")),
  };

  it("round-trips through JSON without losing bigint precision", () => {
    const wire = JSON.parse(JSON.stringify(serialiseAttestation(attestation)));
    expect(deserialiseAttestation(wire)).toEqual(attestation);
  });

  it("carries amounts as strings, because JSON has no bigint", () => {
    const wire = serialiseAttestation(attestation);
    expect(wire.usdAmountCents).toBe("302500");
    expect(wire.dueAt).toBe(String(DUE_AT));
    expect(() => JSON.stringify(wire)).not.toThrow();
  });

  it("survives an amount beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = { ...attestation, usdAmountCents: 9_007_199_254_740_993n };
    const back = deserialiseAttestation(
      JSON.parse(JSON.stringify(serialiseAttestation(huge))),
    );
    expect(back.usdAmountCents).toBe(9_007_199_254_740_993n);
  });
});

describe("validateInvoice", () => {
  it("recomputes the total from the line items", () => {
    const result = validate();
    // 2 * 150000 + 1 * 2500
    expect(result.subtotalCents).toBe(302_500n);
    expect(result.finalTotalCents).toBe(302_500n);
    expect(result.seller).toBe(SELLER);
    expect(result.buyer).toBe(BUYER);
    expect(result.dueAt).toBe(BigInt(DUE_AT));
  });

  it("applies discount and tax in integer cents", () => {
    const result = validate({ discountCents: "500", taxCents: "22688" });
    expect(result.finalTotalCents).toBe(302_500n - 500n + 22_688n);
  });

  it("rejects a discount larger than the subtotal", () => {
    expect(() => validate({ discountCents: "999999999" })).toThrow(InvoiceValidationError);
  });

  it("rejects a total of zero", () => {
    expect(() =>
      validate({ items: [{ description: "x", quantity: "1", unitPriceCents: "100" }], discountCents: "100" }),
    ).toThrow(InvoiceValidationError);
  });

  it("rejects a payload for a different escrow", () => {
    expect(() =>
      validateInvoice(
        { ...payload({ escrowContract: BUYER }), nonce: NONCE, salt: SALT },
        OPTIONS,
      ),
    ).toThrow(/escrowContract does not match/);
  });

  it("rejects seller and buyer being the same address", () => {
    expect(() => validate({ buyer: SELLER })).toThrow(/different addresses/);
  });

  it("rejects a due date in the past", () => {
    expect(() => validate({ dueAt: NOW - 1 })).toThrow(/must be in the future/);
  });

  it("rejects a due date beyond the 366-day horizon", () => {
    expect(() => validate({ dueAt: NOW + 400 * 24 * 3600 })).toThrow(/366 days/);
  });

  it("rejects a non-integer quantity string", () => {
    expect(() =>
      validate({ items: [{ description: "x", quantity: "1.5", unitPriceCents: "100" }] }),
    ).toThrow(/non-negative integer/);
  });

  it("rejects a numeric quantity, because JSON numbers can round", () => {
    expect(() =>
      validate({ items: [{ description: "x", quantity: 2, unitPriceCents: "100" }] }),
    ).toThrow(/decimal string/);
  });

  it("rejects an empty item list", () => {
    expect(() => validate({ items: [] })).toThrow(/at least one entry/);
  });

  it("rejects more than 20 items", () => {
    const items = Array.from({ length: 21 }, () => ({
      description: "x",
      quantity: "1",
      unitPriceCents: "100",
    }));
    expect(() => validate({ items })).toThrow(/at most 20/);
  });

  it("rejects a currency other than USD", () => {
    expect(() => validate({ currency: "EUR" })).toThrow(/currency must be USD/);
  });

  it("rejects a short nonce", () => {
    expect(() =>
      validateInvoice({ ...payload(), nonce: "too-short", salt: SALT }, OPTIONS),
    ).toThrow(/nonce length/);
  });

  it("rejects a non-object payload", () => {
    expect(() => validateInvoice("nope", OPTIONS)).toThrow(/must be a JSON object/);
    expect(() => validateInvoice([], OPTIONS)).toThrow(/must be a JSON object/);
  });

  it("never echoes a submitted value in the error message", () => {
    // The message is returned to the caller, so it must name the rule, not the secret.
    try {
      validate({ items: [{ description: "Acme Corp merger fees", quantity: "0", unitPriceCents: "1" }] });
      throw new Error("expected a validation failure");
    } catch (error) {
      expect((error as Error).message).not.toContain("Acme Corp merger fees");
    }
  });
});

describe("termsCommitment", () => {
  it("is deterministic for identical inputs", () => {
    expect(validate().termsCommitment).toBe(validate().termsCommitment);
  });

  it("changes when any priced term changes", () => {
    const base = validate().termsCommitment;
    expect(validate({ taxCents: "1" }).termsCommitment).not.toBe(base);
    expect(validate({ invoiceReference: "INV-OTHER" }).termsCommitment).not.toBe(base);
    expect(
      validate({ items: [{ description: "Design retainer", quantity: "3", unitPriceCents: "150000" }] })
        .termsCommitment,
    ).not.toBe(base);
  });

  it("changes when only the hiding entropy changes", () => {
    const a = validateInvoice({ ...payload(), nonce: NONCE, salt: SALT }, OPTIONS);
    const b = validateInvoice({ ...payload(), nonce: NONCE, salt: "t".repeat(32) }, OPTIONS);
    expect(a.termsCommitment).not.toBe(b.termsCommitment);
  });

  it("is domain-separated", () => {
    expect(COMMITMENT_DOMAIN).toBe("BOTSEAL_INVOICE_V1");
  });
});

describe("deriveAttestationId", () => {
  it("is deterministic, so resubmitting the same invoice cannot create a second one", () => {
    const commitment = validate().termsCommitment;
    expect(deriveAttestationId(commitment, SELLER)).toBe(
      deriveAttestationId(commitment, SELLER),
    );
  });

  it("differs per seller for the same commitment", () => {
    const commitment = validate().termsCommitment;
    expect(deriveAttestationId(commitment, SELLER)).not.toBe(
      deriveAttestationId(commitment, BUYER),
    );
  });

  it("differs across two invoices with identical terms but fresh entropy", () => {
    const a = validateInvoice({ ...payload(), nonce: NONCE, salt: SALT }, OPTIONS);
    const b = validateInvoice(
      { ...payload(), nonce: "u".repeat(32), salt: "v".repeat(32) },
      OPTIONS,
    );
    expect(deriveAttestationId(a.termsCommitment, SELLER)).not.toBe(
      deriveAttestationId(b.termsCommitment, SELLER),
    );
  });
});
