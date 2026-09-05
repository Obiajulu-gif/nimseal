"use client";

import Link from "next/link";
import { ArrowRight, FilePlus2 } from "lucide-react";
import { useAccount } from "wagmi";

import { EmptyState, PageHeader, PrivacyBadge, StatusBadge } from "@/components/common";
import { RequireWallet } from "@/components/wallet";
import { Alert, Badge, buttonVariants, Card, Spinner } from "@/components/ui/primitives";
import { formatTokenAmount, useSettlementTokenMetadata } from "@/hooks/use-settlement-token";
import {
  mergeInvoiceIds,
  useBuyerInvoiceIds,
  useInvoices,
  useSellerInvoiceIds,
} from "@/hooks/use-invoices";
import { isEscrowConfigured } from "@/lib/env";
import { formatCentsAsCurrency } from "@/lib/invoice";
import { formatDate } from "@/lib/utils";

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Settlement command center"
        title="Dashboard"
        description="Track every invoice where your connected wallet is the seller or buyer, from sealed payload to final settlement."
        action={
          <Link href="/invoices/new" className={buttonVariants()}>
            <FilePlus2 className="h-4 w-4" aria-hidden="true" />
            New invoice
          </Link>
        }
      />

      {!isEscrowConfigured ? (
        <Alert tone="warning" title="Escrow not configured">
          Set <code className="font-mono text-xs">NEXT_PUBLIC_ESCROW_ADDRESS</code> to a deployed
          escrow to load invoices.
        </Alert>
      ) : (
        <RequireWallet>
          <InvoiceList />
        </RequireWallet>
      )}
    </div>
  );
}

function InvoiceList() {
  const { address } = useAccount();
  const seller = useSellerInvoiceIds(address);
  const buyer = useBuyerInvoiceIds(address);

  const ids = mergeInvoiceIds(
    seller.data as readonly bigint[] | undefined,
    buyer.data as readonly bigint[] | undefined,
  );

  const { invoices, isLoading, isError, error } = useInvoices(ids);
  const { symbol, decimals } = useSettlementTokenMetadata();

  const sellerIds = new Set((seller.data as readonly bigint[] | undefined) ?? []);
  const buyerIds = new Set((buyer.data as readonly bigint[] | undefined) ?? []);

  if (seller.isLoading || buyer.isLoading || (ids.length > 0 && isLoading)) {
    return (
      <div className="glass-panel flex items-center gap-3 rounded-2xl border border-white/[0.08] p-10 text-sm text-foreground/60">
        <Spinner /> Loading invoices…
      </div>
    );
  }

  if (seller.isError || buyer.isError || isError) {
    const detail = seller.error ?? buyer.error ?? error;
    return (
      <Alert tone="danger" title="Could not reach the network RPC">
        {detail instanceof Error ? detail.message : "The invoice list could not be loaded."}
      </Alert>
    );
  }

  if (ids.length === 0) {
    return (
      <EmptyState
        title="No invoices yet"
        action={{ href: "/invoices/new", label: "Create your first invoice" }}
      >
        Invoices you issue or receive will appear here.
      </EmptyState>
    );
  }

  return (
    <Card className="overflow-hidden border-white/[0.08]">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-white/[0.07] bg-white/[0.025] text-left text-[0.66rem] uppercase tracking-[0.12em] text-foreground/40">
            <tr>
              <th className="px-4 py-3 font-medium">#</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Total</th>
              <th className="px-4 py-3 font-medium">{symbol}</th>
              <th className="px-4 py-3 font-medium">Due</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Privacy</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => {
              const isSeller = sellerIds.has(invoice.id);
              const isBuyer = buyerIds.has(invoice.id);

              return (
                <tr
                  key={invoice.id.toString()}
                  className="border-b border-white/[0.055] transition-colors hover:bg-white/[0.025] last:border-0"
                >
                  <td className="px-4 py-3 font-mono text-xs">{invoice.id.toString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {isSeller ? <Badge variant="default">Seller</Badge> : null}
                      {isBuyer ? <Badge variant="neutral">Buyer</Badge> : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {formatCentsAsCurrency(invoice.usdAmountCents)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {invoice.tokenAmount > 0n && decimals !== undefined
                      ? formatTokenAmount(invoice.tokenAmount, decimals)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(invoice.dueAt)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={invoice.status} />
                  </td>
                  <td className="px-4 py-3">
                    <PrivacyBadge confidential={invoice.confidential} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/invoices/${invoice.id}`}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-[#ff9678]"
                    >
                      Details <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
