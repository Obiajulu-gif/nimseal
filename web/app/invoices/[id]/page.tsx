"use client";

/**
 * Invoice detail. Renders only what the contract stores — which is, by construction, only public
 * data. There is no plaintext line item to show, because none was ever submitted.
 */

import Link from "next/link";
import { use } from "react";
import { useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";

import {
  AddressLink,
  DetailRow,
  EmptyState,
  PageHeader,
  PrivacyBadge,
  StatusBadge,
} from "@/components/common";
import { ConnectButton } from "@/components/wallet";
import { NimiqSealBadge, SellerSealCard } from "@/components/nimiq-seal";
import {
  Alert,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
} from "@/components/ui/primitives";
import {
  formatTokenAmount,
  useSettlementTokenBalance,
  useSettlementTokenMetadata,
} from "@/hooks/use-settlement-token";
import { useInvoice, useIsBuyer, useIsSeller, useSettlementActions } from "@/hooks/use-invoices";
import { InvoiceStatus, ZERO_BYTES32, type Invoice } from "@/lib/contracts";
import { env, isEscrowConfigured } from "@/lib/env";
import { addressUrl } from "@/lib/explorer";
import { formatCentsAsCurrency } from "@/lib/invoice";
import { formatTimestamp } from "@/lib/utils";

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  if (!/^\d+$/.test(id)) {
    return <EmptyState title="Invalid invoice id">The invoice id must be a number.</EmptyState>;
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="On-chain settlement record"
        title={`Invoice #${id}`}
        description="Inspect the public proof, escrow state, and settlement actions. Confidential line items never appear here."
        action={
          <Link
            href="/dashboard"
            className="text-sm font-medium text-primary transition-colors hover:text-[#ff9678]"
          >
            ← Back to dashboard
          </Link>
        }
      />

      {!isEscrowConfigured ? (
        <Alert tone="warning" title="Escrow not configured">
          Set <code className="font-mono text-xs">NEXT_PUBLIC_ESCROW_ADDRESS</code> to load this
          invoice.
        </Alert>
      ) : (
        // Deliberately NOT wrapped in RequireWallet. Everything this page renders is public
        // on-chain state, so a reviewer following a link should see the record immediately
        // rather than a connect-wallet prompt. Only the settlement actions need a signer, and
        // ActionsPanel gates itself on that.
        <InvoiceDetail invoiceId={BigInt(id)} />
      )}
    </div>
  );
}

function InvoiceDetail({ invoiceId }: { invoiceId: bigint }) {
  const { data, isLoading, isError } = useInvoice(invoiceId);
  const { symbol, decimals } = useSettlementTokenMetadata();
  const { address } = useAccount();
  const sealParam = useSearchParams()?.get("seal") ?? undefined;

  if (isLoading) {
    return (
      <div className="glass-panel flex items-center gap-3 rounded-2xl border border-white/[0.08] p-10 text-sm text-foreground/60">
        <Spinner /> Loading invoice…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <EmptyState title="Invoice not found">
        No invoice with id {invoiceId.toString()} exists in this escrow.
      </EmptyState>
    );
  }

  const invoice = data as unknown as Invoice;
  const hasEscrowedAmount = invoice.tokenAmount > 0n && decimals !== undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Invoice record</CardTitle>
            <StatusBadge status={invoice.status} />
            <PrivacyBadge confidential={invoice.confidential} />
          </div>
          <CardDescription>
            {invoice.confidential
              ? "Created from an attestor-signed result. Line items were never on-chain."
              : "Created through the public fallback path — the commitment is unverified."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl>
            <DetailRow label="Invoice id">{invoice.id.toString()}</DetailRow>
            <DetailRow label="Seller">
              <AddressLink address={invoice.seller} full />
            </DetailRow>
            <DetailRow label="Buyer">
              <AddressLink address={invoice.buyer} full />
            </DetailRow>
            <DetailRow label="Amount due">
              <span className="text-base font-semibold">
                {formatCentsAsCurrency(invoice.usdAmountCents)}
              </span>{" "}
              <span className="text-xs text-muted-foreground">
                ({invoice.usdAmountCents.toString()} cents)
              </span>
            </DetailRow>
            <DetailRow label="Due">{formatTimestamp(invoice.dueAt)}</DetailRow>
            <DetailRow label="Terms commitment" mono>
              {invoice.termsCommitment}
            </DetailRow>
            <DetailRow label="Attestation id" mono>
              {invoice.attestationId === ZERO_BYTES32 ? (
                <span className="text-sm text-muted-foreground">
                  None — this invoice was not validated by the attestor.
                </span>
              ) : (
                invoice.attestationId
              )}
            </DetailRow>
            <DetailRow label={`${symbol} escrowed`}>
              {hasEscrowedAmount ? formatTokenAmount(invoice.tokenAmount, decimals) : "—"}
            </DetailRow>
            <DetailRow label="Created">{formatTimestamp(invoice.createdAt)}</DetailRow>
            <DetailRow label="Funded">{formatTimestamp(invoice.fundedAt)}</DetailRow>
            <DetailRow label="Settled">{formatTimestamp(invoice.settledAt)}</DetailRow>
            <DetailRow label="Escrow contract">
              {env.escrowAddress ? <AddressLink address={env.escrowAddress} full /> : "—"}
            </DetailRow>
          </dl>
        </CardContent>
      </Card>

      <aside className="space-y-6">
        <NimiqSealBadge invoice={invoice} sealParam={sealParam} />
        {invoice.confidential && address && address.toLowerCase() === invoice.seller.toLowerCase() ? (
          <SellerSealCard invoice={invoice} />
        ) : null}
        <ActionsPanel invoice={invoice} />
        <PartyBalances invoice={invoice} />
        <Card>
          <CardHeader>
            <CardTitle>Verify on-chain</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {env.escrowAddress ? (
              <a
                href={addressUrl(env.escrowAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Escrow contract on the explorer ↗
              </a>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Read the invoice storage directly to confirm no plaintext line items are present.
            </p>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

/**
 * Settlement-token balances for both parties to this invoice.
 *
 * Shown side by side rather than only for the connected wallet, because the interesting fact about
 * an escrow is the relationship between the two balances and the amount held in between. On
 * release the seller's figure moves by exactly the escrowed amount, which is the clearest possible
 * evidence that settlement did what it claims.
 *
 * These are live contract reads, refetched whenever a settlement action invalidates the cache.
 */
function PartyBalances({ invoice }: { invoice: Invoice }) {
  const { address } = useAccount();
  const { symbol, decimals } = useSettlementTokenMetadata();

  const sellerBalance = useSettlementTokenBalance(invoice.seller);
  const buyerBalance = useSettlementTokenBalance(invoice.buyer);

  if (!env.settlementTokenAddress) return null;

  const show = (value: bigint | undefined) =>
    value !== undefined && decimals !== undefined ? formatTokenAmount(value, decimals, 4) : "—";

  const rows = [
    { role: "Seller", addr: invoice.seller, balance: sellerBalance.data },
    { role: "Buyer", addr: invoice.buyer, balance: buyerBalance.data },
  ];

  const escrowed =
    invoice.tokenAmount > 0n && decimals !== undefined
      ? formatTokenAmount(invoice.tokenAmount, decimals, 4)
      : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Party balances</CardTitle>
        <CardDescription>Live {symbol} balances for both sides of this invoice.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row) => {
          const isYou = address && row.addr.toLowerCase() === address.toLowerCase();
          return (
            <div key={row.role} className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-foreground/80">
                  {row.role}
                  {isYou ? <span className="ml-1.5 text-xs text-primary">you</span> : null}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  <AddressLink address={row.addr} />
                </p>
              </div>
              <p className="shrink-0 font-mono text-sm font-medium">
                {show(row.balance)} <span className="text-xs text-muted-foreground">{symbol}</span>
              </p>
            </div>
          );
        })}

        {escrowed ? (
          <div className="flex items-baseline justify-between gap-3 border-t border-white/[0.06] pt-3">
            <p className="text-sm text-foreground/60">Held in escrow</p>
            <p className="shrink-0 font-mono text-sm font-medium text-primary">
              {escrowed} <span className="text-xs text-muted-foreground">{symbol}</span>
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ActionsPanel({ invoice }: { invoice: Invoice }) {
  const { address } = useAccount();
  const isBuyer = useIsBuyer(invoice);
  const isSeller = useIsSeller(invoice);
  const actions = useSettlementActions(invoice.id);

  const now = Math.floor(Date.now() / 1000);
  const expiredRefundAvailable =
    invoice.status === InvoiceStatus.Funded && now > Number(invoice.dueAt);

  // Disconnected visitors still see the full record above; only the actions need a signer.
  if (!address) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
          <CardDescription>
            Connect the seller or buyer wallet to fund, release, refund, or cancel this invoice.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ConnectButton />
        </CardContent>
      </Card>
    );
  }

  if (!isBuyer && !isSeller) {
    return (
      <Alert tone="info" title="Read-only">
        You are neither the seller nor the buyer on this invoice.
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
        <CardDescription>{isSeller ? "You are the seller." : "You are the buyer."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {invoice.status === InvoiceStatus.Pending && isBuyer ? (
          <Link href={`/pay/${invoice.id}`} className={buttonVariants({ className: "w-full" })}>
            Fund this invoice
          </Link>
        ) : null}

        {invoice.status === InvoiceStatus.Pending && isSeller ? (
          <Button
            variant="outline"
            className="w-full"
            disabled={actions.isPending}
            onClick={() => actions.cancel()}
          >
            Cancel invoice
          </Button>
        ) : null}

        {invoice.status === InvoiceStatus.Funded && isBuyer ? (
          <Button
            className="w-full"
            disabled={actions.isPending}
            onClick={() => actions.release()}
          >
            {actions.isPending ? <Spinner /> : null}
            Release payment to seller
          </Button>
        ) : null}

        {invoice.status === InvoiceStatus.Funded && isSeller ? (
          <Button
            variant="outline"
            className="w-full"
            disabled={actions.isPending}
            onClick={() => actions.refund()}
          >
            Refund the buyer
          </Button>
        ) : null}

        {invoice.status === InvoiceStatus.Funded && isBuyer ? (
          <div>
            <Button
              variant="destructive"
              className="w-full"
              disabled={actions.isPending || !expiredRefundAvailable}
              onClick={() => actions.claimExpired()}
            >
              Reclaim expired escrow
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Available only after the due date plus the contract&apos;s refund grace period. The
              contract enforces the exact window.
            </p>
          </div>
        ) : null}

        {invoice.status !== InvoiceStatus.Pending && invoice.status !== InvoiceStatus.Funded ? (
          <p className="text-sm text-muted-foreground">
            This invoice is settled. No further actions are available.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
