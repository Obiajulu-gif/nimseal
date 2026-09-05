"use client";

/**
 * Small presentational pieces shared across pages: hash links, status badges, and the labelled
 * key/value rows used on the invoice detail view.
 */

import Link from "next/link";
import { Check, Copy, Share2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { InvoiceStatus, invoiceStatusLabel } from "@/lib/contracts";
import { addressUrl, shortenHex, txUrl } from "@/lib/explorer";
import { Badge, type BadgeProps } from "@/components/ui/primitives";

/**
 * Copies text to the clipboard with a WebView-safe fallback.
 *
 * The async Clipboard API is unavailable in insecure contexts (an HTTP LAN URL during Nimiq Pay
 * testing) and can be absent in some WebViews, so a hidden-textarea + `execCommand` path backs it
 * up. Never throws; reports failure through the returned boolean.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const el = document.createElement("textarea");
    el.value = value;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

/** A compact icon button that copies `value` and briefly confirms. */
export function CopyButton({ value, label = "value" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        const ok = await copyText(value);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } else {
          toast.error("Could not copy. Select and copy manually.");
        }
      }}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-foreground/60 transition-colors hover:border-primary/30 hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/**
 * Shares a link via the Web Share API where available, copying it otherwise. Progressive
 * enhancement: the button always works, and the native share sheet is a bonus on mobile.
 */
export function ShareButton({
  url,
  title,
  text,
  className,
  children,
}: {
  url: string;
  title?: string;
  text?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        const shareData = { title, text, url };
        try {
          if (typeof navigator !== "undefined" && navigator.share) {
            await navigator.share(shareData);
            return;
          }
        } catch {
          return; // user dismissed the share sheet; nothing to do
        }
        const ok = await copyText(url);
        toast[ok ? "success" : "error"](ok ? "Payment link copied." : "Could not copy the link.");
      }}
    >
      <Share2 className="h-4 w-4" aria-hidden="true" />
      {children ?? "Share"}
    </button>
  );
}

export function AddressLink({ address, full = false }: { address: string; full?: boolean }) {
  return (
    <a
      href={addressUrl(address)}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-xs text-primary transition-colors hover:text-[#ff9678] hover:underline"
    >
      {full ? address : shortenHex(address)}
    </a>
  );
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a
      href={txUrl(hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-xs text-primary transition-colors hover:text-[#ff9678] hover:underline"
    >
      {label ?? shortenHex(hash, 10, 8)}
    </a>
  );
}

const STATUS_TONE: Record<number, BadgeProps["variant"]> = {
  [InvoiceStatus.Pending]: "warning",
  [InvoiceStatus.Funded]: "default",
  [InvoiceStatus.Released]: "success",
  [InvoiceStatus.Refunded]: "neutral",
  [InvoiceStatus.Cancelled]: "neutral",
};

export function StatusBadge({ status }: { status: number }) {
  return <Badge variant={STATUS_TONE[status] ?? "neutral"}>{invoiceStatusLabel(status)}</Badge>;
}

export function PrivacyBadge({ confidential }: { confidential: boolean }) {
  return confidential ? (
    <Badge variant="success">Confidential</Badge>
  ) : (
    <Badge variant="warning">Public fallback</Badge>
  );
}

/** A labelled row on a detail panel. `mono` is for hashes and addresses. */
export function DetailRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-white/[0.06] py-3.5 last:border-0 sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm text-foreground/45">{label}</dt>
      <dd className={`sm:col-span-2 ${mono ? "hex" : "text-sm"}`}>{children}</dd>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col justify-between gap-5 border-b border-white/[0.07] pb-7 sm:flex-row sm:items-end">
      <div className="max-w-3xl">
        <p className="eyebrow mb-3">{eyebrow}</p>
        <h1 className="font-display text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">
          {title}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-foreground/60">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className="glass-panel rounded-2xl border border-dashed border-white/10 p-12 text-center">
      <p className="font-display text-lg font-semibold">{title}</p>
      {children ? <p className="mt-2 text-sm text-foreground/60">{children}</p> : null}
      {action ? (
        <Link
          href={action.href}
          className="mt-5 inline-block rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_12px_35px_hsl(var(--primary)/0.22)] transition-transform hover:-translate-y-0.5"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
