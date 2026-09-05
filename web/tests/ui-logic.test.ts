/**
 * Status labels, explorer URLs, form validation, and error translation.
 */

import { describe, expect, it } from "vitest";

import { settlementChain, explorerBaseUrl } from "@/lib/chain";
import { InvoiceStatus, invoiceStatusLabel } from "@/lib/contracts";
import { explainError } from "@/lib/errors";
import { addressUrl, shortenHex, txUrl } from "@/lib/explorer";
import { formatTokenAmount } from "@/hooks/use-settlement-token";
import { dueDateToUnix, invoiceFormSchema } from "@/lib/validation";

const ADDRESS = "0x1234567890123456789012345678901234567890";
const TX = `0x${"ab".repeat(32)}`;

describe("invoiceStatusLabel", () => {
  it("labels every on-chain status", () => {
    expect(invoiceStatusLabel(InvoiceStatus.Pending)).toBe("Pending");
    expect(invoiceStatusLabel(InvoiceStatus.Funded)).toBe("Funded");
    expect(invoiceStatusLabel(InvoiceStatus.Released)).toBe("Released");
    expect(invoiceStatusLabel(InvoiceStatus.Refunded)).toBe("Refunded");
    expect(invoiceStatusLabel(InvoiceStatus.Cancelled)).toBe("Cancelled");
  });

  it("falls back for an unknown value rather than rendering undefined", () => {
    expect(invoiceStatusLabel(99)).toBe("Unknown");
    expect(invoiceStatusLabel(InvoiceStatus.None)).toBe("Unknown");
  });
});

describe("explorer URLs", () => {
  const base = explorerBaseUrl();

  it("builds a transaction URL on the configured explorer", () => {
    expect(txUrl(TX)).toBe(`${base}/tx/${TX}`);
  });

  it("builds an address URL on the configured explorer", () => {
    expect(addressUrl(ADDRESS)).toBe(`${base}/address/${ADDRESS}`);
  });

  it("never produces a double slash", () => {
    expect(txUrl(TX)).not.toMatch(/[^:]\/\//);
  });
});

describe("shortenHex", () => {
  it("shortens a long hash", () => {
    expect(shortenHex(ADDRESS)).toBe("0x123456…7890");
  });

  it("leaves a short value alone", () => {
    expect(shortenHex("0x1234")).toBe("0x1234");
  });

  it("passes through non-hex text", () => {
    expect(shortenHex("not a hash")).toBe("not a hash");
  });
});

describe("formatTokenAmount", () => {
  it("formats a 6-decimal settlement token", () => {
    expect(formatTokenAmount(200_000_000n, 6)).toBe("200");
    expect(formatTokenAmount(1_500_000n, 6)).toBe("1.5");
  });

  it("trims trailing zeros", () => {
    expect(formatTokenAmount(1_100_000n, 6)).toBe("1.1");
  });

  it("formats a sub-unit amount", () => {
    expect(formatTokenAmount(1n, 6)).toBe("0.000001");
  });

  it("formats zero", () => {
    expect(formatTokenAmount(0n, 6)).toBe("0");
  });
});

describe("dueDateToUnix", () => {
  it("maps a date to end-of-day UTC", () => {
    expect(dueDateToUnix("2027-01-15")).toBe(Math.floor(Date.parse("2027-01-15T23:59:59Z") / 1000));
  });

  it("rejects a malformed date", () => {
    expect(dueDateToUnix("15/01/2027")).toBeUndefined();
    expect(dueDateToUnix("")).toBeUndefined();
  });
});

describe("invoiceFormSchema", () => {
  const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const validForm = {
    buyer: ADDRESS,
    invoiceReference: "INV-2026-014",
    dueDate: future,
    items: [{ description: "Design retainer", quantity: "2", unitPriceUsd: "1250.00" }],
    taxUsd: "",
    discountUsd: "",
  };

  it("accepts a well-formed invoice", () => {
    expect(invoiceFormSchema.safeParse(validForm).success).toBe(true);
  });

  it("rejects an invalid buyer address", () => {
    const result = invoiceFormSchema.safeParse({ ...validForm, buyer: "0xnope" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === "buyer")).toBe(true);
  });

  it("rejects a past due date", () => {
    const result = invoiceFormSchema.safeParse({ ...validForm, dueDate: "2020-01-01" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => /future/.test(i.message))).toBe(true);
  });

  it("rejects a due date beyond the attestor's 366-day horizon", () => {
    const tooFar = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const result = invoiceFormSchema.safeParse({ ...validForm, dueDate: tooFar });
    expect(result.success).toBe(false);
  });

  it("rejects an empty item list", () => {
    expect(invoiceFormSchema.safeParse({ ...validForm, items: [] }).success).toBe(false);
  });

  it("rejects a unit price with three decimals", () => {
    const result = invoiceFormSchema.safeParse({
      ...validForm,
      items: [{ description: "x", quantity: "1", unitPriceUsd: "10.005" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a blank description", () => {
    const result = invoiceFormSchema.safeParse({
      ...validForm,
      items: [{ description: "   ", quantity: "1", unitPriceUsd: "10.00" }],
    });
    expect(result.success).toBe(false);
  });

  it("allows blank tax and discount", () => {
    expect(
      invoiceFormSchema.safeParse({ ...validForm, taxUsd: "", discountUsd: "" }).success,
    ).toBe(true);
  });
});

describe("explainError", () => {
  it("translates escrow custom errors", () => {
    expect(explainError(new Error("execution reverted: NotBuyer()"))).toMatch(/only the buyer/i);
    expect(explainError(new Error("AttestationAlreadyConsumed()"))).toMatch(/already been used/i);
    expect(explainError(new Error("InvalidAttestorSignature()"))).toMatch(/signature/i);
  });

  it("recognises a user rejection", () => {
    expect(explainError(new Error("User rejected the request"))).toMatch(/cancelled/i);
  });

  it("recognises insufficient gas funds and names the native token", () => {
    expect(explainError(new Error("insufficient funds for gas * price + value"))).toContain(
      settlementChain.nativeCurrency.symbol,
    );
  });

  it("explains the wrong-network gas estimation failure in terms of the network", () => {
    // The exact string a wallet left on another chain produces.
    const raw =
      'The contract function "createPublicInvoice" reverted with the following reason: ' +
      "RPC 0x1 Infura eth_sendRawTransaction: gas required exceeds allowance (0)";
    const explained = explainError(new Error(raw));
    expect(explained).toContain(settlementChain.name);
  });

  it("tells the user to switch networks on a chain mismatch", () => {
    expect(explainError(new Error("ChainMismatchError: chain does not match"))).toMatch(
      /wrong network/i,
    );
  });

  it("names the chain this build is pinned to", () => {
    // A build that says only "switch networks" is useless: the message must name the configured
    // network and its id so the user lands on the right chain and escrow.
    const explained = explainError(new Error("ChainMismatchError: chain does not match"));
    expect(explained).toContain(settlementChain.name);
    expect(explained).toContain(String(settlementChain.id));
  });

  it("recognises an ERC-20 allowance failure", () => {
    expect(explainError(new Error("ERC20InsufficientAllowance"))).toMatch(/approve/i);
  });

  it("falls back to a generic message for unrecognised errors", () => {
    expect(explainError(new Error("0x1234abcd raw rpc noise here and there"))).toBeTruthy();
  });

  it("never returns an empty string", () => {
    for (const input of [undefined, null, "", {}, new Error("")]) {
      expect(explainError(input).length).toBeGreaterThan(0);
    }
  });
});
