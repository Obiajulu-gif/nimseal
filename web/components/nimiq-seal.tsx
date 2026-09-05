"use client";

/**
 * The Nimiq Invoice Seal UI: the seller's sealing action and the buyer's verification badge.
 *
 * This is where the Nimiq-native integration becomes a trust primitive rather than a connection
 * indicator. The seller signs the invoice's public facts with their Nimiq key; anyone with the
 * payment link can verify, with no server, that a specific Nimiq wallet sealed exactly this invoice.
 */

import { useMemo, useState } from "react";
import { BadgeCheck, ChevronDown, ShieldCheck } from "lucide-react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
} from "@/components/ui/primitives";
import { CopyButton, ShareButton } from "@/components/common";
import { useNimiq } from "@/hooks/use-nimiq";
import type { Invoice } from "@/lib/contracts";
import {
  decodeSeal,
  encodeSeal,
  shortenNimiqAddress,
  verifySeal,
  type EncodedSeal,
} from "@/lib/nimiq/seal";
import { loadSeal, saveSeal, sealSubjectFromInvoice } from "@/lib/nimiq/seal-store";

function paymentUrl(invoiceId: bigint, seal?: string): string {
  const base = typeof window !== "undefined" ? window.location.origin : "";
  const query = seal ? `?seal=${seal}` : "";
  return `${base}/pay/${invoiceId}${query}`;
}

/**
 * Seller-facing card shown on a confidential invoice they own. Lets them seal the invoice with
 * their Nimiq wallet and produces a self-verifying payment link.
 */
export function SellerSealCard({ invoice }: { invoice: Invoice }) {
  const subject = useMemo(() => sealSubjectFromInvoice(invoice), [invoice]);
  const { state, seal } = useNimiq();
  const [encoded, setEncoded] = useState<string | undefined>(() => {
    const stored = loadSeal(invoice.id);
    return stored ? encodeSealFromStored(stored) : undefined;
  });

  if (!subject) return null;

  const busy = state.status === "requesting-permission";
  const link = paymentUrl(invoice.id, encoded);

  async function onSeal() {
    if (!subject) return;
    const result = await seal(subject);
    if (!result) return;
    const enc = encodeSeal(result.proof, result.address);
    saveSeal(invoice.id, decodeSeal(enc)!);
    setEncoded(enc);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          <CardTitle>Nimiq invoice seal</CardTitle>
        </div>
        <CardDescription>
          {encoded
            ? "This invoice is sealed. Share the link — the buyer can verify your Nimiq wallet."
            : "Sign this invoice with your Nimiq wallet so the buyer can verify it came from you."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {encoded ? (
          <>
            <div className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.07] px-3 py-2.5 text-sm text-emerald-200">
              <BadgeCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
              Sealed by {shortenNimiqAddress(loadSeal(invoice.id)?.nq ?? "")}
            </div>
            <div className="flex flex-wrap gap-2">
              <ShareButton
                url={link}
                title={`nimSeal invoice #${invoice.id}`}
                text="Pay this confidential invoice with Nimiq Pay"
                className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-primary to-[#ff4d2e] px-4 text-sm font-semibold text-primary-foreground"
              >
                Share payment link
              </ShareButton>
              <CopyButton value={link} label="payment link" />
            </div>
          </>
        ) : (
          <Button className="w-full" disabled={busy} onClick={onSeal}>
            {busy ? <Spinner /> : <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
            Seal with Nimiq wallet
          </Button>
        )}

        {state.error && state.status !== "connected" ? (
          <Alert tone="warning">{state.error}</Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function encodeSealFromStored(stored: EncodedSeal): string {
  // Re-encode from the cached fields so the link is byte-for-byte the shareable form.
  return encodeSeal({ publicKey: stored.pk, signature: stored.sig }, stored.nq);
}

/**
 * Buyer-facing verification of a decoded seal against an invoice. Shows a verified badge with an
 * expandable technical breakdown, or a clear "not verified" state. Never trusts the address that
 * ships in the seal — it is re-derived from the public key during verification.
 */
export function NimiqSealBadge({ invoice, sealParam }: { invoice: Invoice; sealParam?: string }) {
  const [open, setOpen] = useState(false);

  const decoded = useMemo(() => (sealParam ? decodeSeal(sealParam) : loadSeal(invoice.id)), [
    sealParam,
    invoice.id,
  ]);
  const subject = useMemo(() => sealSubjectFromInvoice(invoice), [invoice]);

  const verifiedAddress = useMemo(() => {
    if (!decoded || !subject) return undefined;
    return verifySeal(subject, { publicKey: decoded.pk, signature: decoded.sig });
  }, [decoded, subject]);

  if (!decoded) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-foreground/55">
        <ShieldCheck className="h-4 w-4 shrink-0 text-foreground/40" aria-hidden="true" />
        Not sealed with a Nimiq wallet.
      </div>
    );
  }

  if (!verifiedAddress) {
    return (
      <Alert tone="danger" title="Seal did not verify">
        The Nimiq seal on this link does not match this invoice. Treat the link with caution.
      </Alert>
    );
  }

  return (
    <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.07]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <BadgeCheck className="h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-emerald-200">Nimiq verified</span>
          <span className="block truncate font-mono text-xs text-emerald-200/70">
            Sealed by {shortenNimiqAddress(verifiedAddress)}
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-emerald-200/60 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <dl className="space-y-2 border-t border-emerald-400/15 px-3 py-3 text-xs">
          <SealRow label="Nimiq address" value={verifiedAddress} copy />
          <SealRow label="Public key" value={decoded.pk} copy mono />
          <SealRow label="Signature" value={decoded.sig} copy mono />
          <SealRow label="Commitment" value={invoice.termsCommitment} mono />
          <p className="pt-1 text-emerald-200/60">
            The signature was checked against this invoice&apos;s on-chain facts. The address is
            derived from the public key, not taken from the link.
          </p>
        </dl>
      ) : null}
    </div>
  );
}

function SealRow({
  label,
  value,
  copy = false,
  mono = false,
}: {
  label: string;
  value: string;
  copy?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="shrink-0 text-emerald-200/60">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <span className={`truncate ${mono ? "font-mono" : ""} text-emerald-100/90`}>
          {mono ? `${value.slice(0, 10)}…${value.slice(-6)}` : value}
        </span>
        {copy ? <CopyButton value={value} label={label} /> : null}
      </dd>
    </div>
  );
}

/** Small inline badge for lists — verified/sealed/unsealed at a glance. */
export function SealStatusPill({ invoice }: { invoice: Invoice }) {
  const decoded = loadSeal(invoice.id);
  const subject = sealSubjectFromInvoice(invoice);
  if (!decoded || !subject) return null;
  const ok = verifySeal(subject, { publicKey: decoded.pk, signature: decoded.sig });
  return ok ? <Badge variant="success">Nimiq sealed</Badge> : null;
}
