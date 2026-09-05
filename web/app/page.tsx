"use client";

import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  CircleDollarSign,
  Cpu,
  FileLock2,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import { ConnectButton } from "@/components/wallet";
import { BrandMark } from "@/components/brand";
import {
  Badge,
  buttonVariants,
  Card,
  CardContent,
} from "@/components/ui/primitives";
import { useConfidentialAvailable } from "@/hooks/use-invoices";
import { settlementChain, isTestnet } from "@/lib/chain";
import { cn } from "@/lib/utils";

const STEPS: Array<{ icon: LucideIcon; title: string; description: string }> = [
  {
    icon: FileLock2,
    title: "Protect",
    description: "Line items, identities and tax detail are encrypted in your browser before they leave your device.",
  },
  {
    icon: BadgeCheck,
    title: "Seal",
    description: "You sign the invoice with your Nimiq wallet, so the buyer can verify it came from you.",
  },
  {
    icon: CircleDollarSign,
    title: "Settle",
    description: "The buyer funds the exact amount in USDT through Nimiq Pay, held in escrow until release.",
  },
];

const PRIVATE_FIELDS = ["Line items", "Customer identity", "Tax details", "Nonce + salt"];
const PUBLIC_FIELDS = ["Seller + buyer", "USD total", "Due date", "32-byte commitment"];

export default function HomePage() {
  const confidential = useConfidentialAvailable();

  return (
    <div className="space-y-12 sm:space-y-16">
      {/* Hero */}
      <section className="pt-2 text-center sm:pt-6 sm:text-left">
        <div className="mb-5 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
          <Badge variant="default" className="border-primary/25 bg-primary/[0.08]">
            <BrandMark className="h-3.5 w-3.5" />
            Nimiq Pay Mini App
          </Badge>
          <Badge variant="neutral">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {settlementChain.name}
            {isTestnet ? " · testnet" : ""}
          </Badge>
        </div>

        <h1 className="font-display text-4xl font-semibold leading-[1.02] tracking-[-0.04em] sm:text-5xl">
          Private invoices.
          <span className="text-gradient block">Protected payments.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-foreground/70 sm:mx-0">
          Create confidential invoices, seal them with your Nimiq wallet, and receive USDT through
          protected escrow — all inside Nimiq Pay.
        </p>

        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          <Link href="/invoices/new" className={cn(buttonVariants({ size: "lg" }), "w-full sm:w-auto")}>
            Create invoice
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <Link
            href="/dashboard"
            className={cn(buttonVariants({ size: "lg", variant: "outline" }), "w-full sm:w-auto")}
          >
            View invoices
          </Link>
        </div>

        <div className="mt-5 flex justify-center sm:justify-start">
          <ConnectButton />
        </div>
      </section>

      {/* How it works */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-semibold tracking-[-0.03em] sm:text-2xl">
            How BotSeal works
          </h2>
          {confidential.isLoading ? (
            <Badge variant="neutral">Checking</Badge>
          ) : confidential.available ? (
            <Badge variant="success">Attestor online</Badge>
          ) : (
            <Badge variant="warning">Setup pending</Badge>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {STEPS.map(({ icon: Icon, title, description }, i) => (
            <Card key={title} className="p-5">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/20 bg-primary/[0.08] text-primary">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="font-mono text-xs text-foreground/30">0{i + 1}</span>
              </div>
              <p className="font-display text-base font-semibold">{title}</p>
              <p className="mt-1.5 text-sm leading-6 text-foreground/60">{description}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Privacy boundary */}
      <section>
        <Card className="p-5 sm:p-6">
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 className="font-display text-lg font-semibold tracking-[-0.02em]">
              What stays private
            </h2>
          </div>
          <CardContent className="grid gap-4 p-0 sm:grid-cols-2">
            <FieldZone title="Encrypted, off-chain" accent="private" items={PRIVATE_FIELDS} />
            <FieldZone title="Minimal, on-chain" accent="public" items={PUBLIC_FIELDS} />
          </CardContent>
          <p className="mt-4 text-xs leading-5 text-foreground/50">
            An off-chain attestor decrypts the invoice, recomputes every total, and signs only the
            settlement facts. It is a server key, not a TEE — BotSeal never claims zero-knowledge.
          </p>
        </Card>
      </section>

      {/* Nimiq seal callout */}
      <section>
        <Card className="border-accent/15 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
              <Cpu className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-display text-lg font-semibold tracking-[-0.02em]">
                Sealed by your Nimiq wallet
              </h2>
              <p className="mt-1.5 text-sm leading-6 text-foreground/60">
                Each invoice is signed with your Nimiq key. The buyer&apos;s payment link verifies the
                signature against the on-chain facts and shows{" "}
                <span className="text-emerald-300">Nimiq verified · NQ…</span> — no server, no trust
                required.
              </p>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}

function FieldZone({
  title,
  accent,
  items,
}: {
  title: string;
  accent: "private" | "public";
  items: string[];
}) {
  const isPrivate = accent === "private";
  return (
    <div
      className={`rounded-2xl border p-4 ${
        isPrivate ? "border-primary/20 bg-primary/[0.05]" : "border-accent/20 bg-accent/[0.045]"
      }`}
    >
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-foreground/50">
        {title}
      </p>
      <ul className="mt-3 space-y-2 text-sm text-foreground/70">
        {items.map((item) => (
          <li key={item} className="flex items-center gap-2.5">
            <span className={`h-1 w-1 rounded-full ${isPrivate ? "bg-primary" : "bg-accent"}`} />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
