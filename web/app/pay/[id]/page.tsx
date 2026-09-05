"use client";

/**
 * Buyer payment flow.
 *
 * The amount comes from the contract's own `quoteInvoice`, so the number shown is the number the
 * contract charges. It is never passed back in: `fundInvoice` recomputes it from the invoice's
 * stored cent total, and this page supplies no amount at all.
 */

import Link from "next/link";
import { use } from "react";
import { useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";

import { AddressLink, PageHeader, StatusBadge } from "@/components/common";
import { NimiqSealBadge } from "@/components/nimiq-seal";
import { RequireWallet } from "@/components/wallet";
import {
  Alert,
  Badge,
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
  useApproveSettlementToken,
  useSettlementTokenAllowance,
  useSettlementTokenBalance,
  useSettlementTokenMetadata,
  useInvoiceQuote,
} from "@/hooks/use-settlement-token";
import { useInvoice, useSettlementActions } from "@/hooks/use-invoices";
import { InvoiceStatus, type Invoice } from "@/lib/contracts";
import { isEscrowConfigured } from "@/lib/env";
import { formatCentsAsCurrency } from "@/lib/invoice";
import { formatTimestamp } from "@/lib/utils";

export default function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  if (!/^\d+$/.test(id)) {
    return (
      <Alert tone="danger" title="Invalid invoice id">
        The invoice id must be a number.
      </Alert>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Escrow funding"
        title={`Pay invoice #${id}`}
        description="Review the amount due, approve exactly that much, and fund the escrow without exposing private invoice terms."
        action={
          <Link
            href={`/invoices/${id}`}
            className="text-sm font-medium text-primary transition-colors hover:text-[#ff9678]"
          >
            View invoice details →
          </Link>
        }
      />

      {!isEscrowConfigured ? (
        <Alert tone="warning" title="Escrow not configured">
          Set <code className="font-mono text-xs">NEXT_PUBLIC_ESCROW_ADDRESS</code> to continue.
        </Alert>
      ) : (
        <RequireWallet>
          <PayFlow invoiceId={BigInt(id)} />
        </RequireWallet>
      )}
    </div>
  );
}

function PayFlow({ invoiceId }: { invoiceId: bigint }) {
  const { address } = useAccount();
  const sealParam = useSearchParams()?.get("seal") ?? undefined;
  const { data, isLoading } = useInvoice(invoiceId);
  const invoice = data as unknown as Invoice | undefined;

  const { symbol, decimals } = useSettlementTokenMetadata();
  const balance = useSettlementTokenBalance(address);
  const allowance = useSettlementTokenAllowance(address);
  const approve = useApproveSettlementToken();
  const actions = useSettlementActions(invoiceId);


  const isPending = invoice?.status === InvoiceStatus.Pending;
  const quote = useInvoiceQuote(invoiceId, isPending);

  if (isLoading) {
    return (
      <div className="glass-panel flex items-center gap-3 rounded-2xl border border-white/[0.08] p-10 text-sm text-foreground/60">
        <Spinner /> Loading invoice…
      </div>
    );
  }

  if (!invoice) {
    return (
      <Alert tone="danger" title="Invoice not found">
        No invoice with id {invoiceId.toString()} exists in this escrow.
      </Alert>
    );
  }

  // Only the named buyer can fund. Checked here for clarity; the contract enforces it.
  if (!address || address.toLowerCase() !== invoice.buyer.toLowerCase()) {
    return (
      <Alert tone="warning" title="You are not the buyer on this invoice">
        <p>
          This invoice can only be funded by <AddressLink address={invoice.buyer} full />.
        </p>
      </Alert>
    );
  }

  if (!isPending) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Nothing to pay</CardTitle>
            <StatusBadge status={invoice.status} />
          </div>
          <CardDescription>
            This invoice is no longer pending, so it cannot be funded.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={`/invoices/${invoiceId}`} className={buttonVariants({ variant: "outline" })}>
            View invoice
          </Link>
        </CardContent>
      </Card>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (now > Number(invoice.dueAt)) {
    return (
      <Alert tone="danger" title="This invoice has expired">
        The due date ({formatTimestamp(invoice.dueAt)}) has passed, so the contract will no longer
        accept funding.
      </Alert>
    );
  }

  // Fixed for the life of the invoice: a USD total settled in a USD stablecoin cannot be
  // repriced, so there is no slippage ceiling to choose and no quote to age out.
  const required = quote.data as bigint | undefined;
  const currentAllowance = (allowance.data as bigint | undefined) ?? 0n;
  const currentBalance = (balance.data as bigint | undefined) ?? 0n;

  const needsApproval = required !== undefined && currentAllowance < required;
  const insufficientBalance = required !== undefined && currentBalance < required;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Payment</CardTitle>
          <CardDescription>
            The amount was fixed when this invoice was created. It cannot move between now and the
            moment you fund.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">Amount due</span>
            <span className="text-2xl font-semibold">
              {formatCentsAsCurrency(invoice.usdAmountCents)}
            </span>
          </div>

          {quote.isLoading ? (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Spinner /> Reading the amount due…
            </div>
          ) : quote.isError ? (
            <Alert tone="danger" title="Could not read the amount due">
              <p>
                {quote.error instanceof Error
                  ? quote.error.message.slice(0, 200)
                  : "The escrow did not return an amount."}
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => quote.refetch()}>
                Retry
              </Button>
            </Alert>
          ) : required !== undefined && decimals !== undefined ? (
            <dl className="space-y-3 text-sm">
              <QuoteRow
                label={`Required ${symbol}`}
                value={formatTokenAmount(required, decimals)}
                emphasis
              />
              <QuoteRow
                label={`Your ${symbol} balance`}
                value={formatTokenAmount(currentBalance, decimals)}
              />
              <QuoteRow
                label="Current allowance"
                value={formatTokenAmount(currentAllowance, decimals)}
              />
            </dl>
          ) : null}

          {insufficientBalance ? (
            <Alert tone="warning" title={`Not enough ${symbol}`}>
              You need at least{" "}
              {decimals !== undefined ? formatTokenAmount(required!, decimals) : "—"} {symbol} in
              this wallet to fund the escrow.
            </Alert>
          ) : null}

          <div className="flex flex-wrap gap-3 border-t border-border pt-4">
            <Button
              disabled={!needsApproval || approve.isPending || required === undefined}
              onClick={() => required !== undefined && approve.mutate(required)}
            >
              {approve.isPending ? <Spinner /> : null}
              {needsApproval ? `Approve ${symbol}` : `${symbol} approved`}
            </Button>

            <Button
              variant={needsApproval ? "outline" : "default"}
              disabled={
                needsApproval || insufficientBalance || actions.isPending || required === undefined
              }
              onClick={() => actions.fund()}
            >
              {actions.isPending ? <Spinner /> : null}
              Fund escrow
            </Button>
          </div>
        </CardContent>
      </Card>

      <aside className="space-y-6">
        <NimiqSealBadge invoice={invoice} sealParam={sealParam} />
        <Card>
          <CardHeader>
            <CardTitle>Invoice</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Seller</span>
              <AddressLink address={invoice.seller} />
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Due</span>
              <span>{formatTimestamp(invoice.dueAt)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Privacy</span>
              <Badge variant={invoice.confidential ? "success" : "warning"}>
                {invoice.confidential ? "Confidential" : "Public fallback"}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Alert tone="info" title="How funding settles">
          <p className="text-muted-foreground">
            Funding transfers exactly the amount the contract computes. Your balance
            is held by the escrow until you release it to the seller, the seller refunds you, or the
            grace period lets you reclaim it.
          </p>
        </Alert>
      </aside>
    </div>
  );
}

function QuoteRow({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={emphasis ? "text-base font-semibold" : ""}>{value}</dd>
    </div>
  );
}
