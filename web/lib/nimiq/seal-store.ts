"use client";

/**
 * Per-viewer persistence for Nimiq invoice seals, and the bridge from an on-chain invoice to a
 * {@link SealSubject}.
 *
 * A seal is off-chain proof that a specific Nimiq wallet signed an invoice's public facts. It rides
 * in the payment link (`?seal=`) so verification is self-contained, and it is also cached in
 * `localStorage` so the seller sees their own seal without re-signing. Every storage access is
 * guarded — `localStorage` throws in private windows and some WebViews, and must never break a page.
 */

import type { Invoice } from "@/lib/contracts";
import { env } from "@/lib/env";
import type { EncodedSeal, SealSubject } from "./seal";

/** Builds the canonical seal subject from an on-chain invoice and the app's configured context. */
export function sealSubjectFromInvoice(invoice: Invoice): SealSubject | undefined {
  if (!env.escrowAddress) return undefined;
  return {
    chainId: env.chainId,
    escrow: env.escrowAddress,
    invoiceId: invoice.id,
    termsCommitment: invoice.termsCommitment,
    usdAmountCents: invoice.usdAmountCents,
    dueAt: invoice.dueAt,
  };
}

function key(invoiceId: bigint): string {
  return `nimseal.seal.${env.chainId}.${(env.escrowAddress ?? "").toLowerCase()}.${invoiceId}`;
}

export function loadSeal(invoiceId: bigint): EncodedSeal | undefined {
  try {
    const raw = localStorage.getItem(key(invoiceId));
    return raw ? (JSON.parse(raw) as EncodedSeal) : undefined;
  } catch {
    return undefined;
  }
}

export function saveSeal(invoiceId: bigint, seal: EncodedSeal): void {
  try {
    localStorage.setItem(key(invoiceId), JSON.stringify(seal));
  } catch {
    // A non-persisted seal still travels in the payment link; losing the cache is not fatal.
  }
}
