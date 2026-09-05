"use client";

/**
 * A calm, dismissible banner shown when BotSeal is opened in a normal browser instead of inside
 * Nimiq Pay. The web build still renders every public page (invoice records, payment summaries) —
 * only wallet actions need the host — so this explains rather than blocks.
 */

import { useEffect, useState } from "react";
import { Wallet, X } from "lucide-react";

import { isInsideNimiqPay } from "@/lib/nimiq/provider";
import { CopyButton } from "@/components/common";

export function NimiqGate() {
  const [outside, setOutside] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [url, setUrl] = useState("");

  useEffect(() => {
    // Give the host a moment to inject the provider before deciding we are outside it.
    setUrl(window.location.href);
    const check = () => setOutside(!isInsideNimiqPay());
    check();
    const t = setTimeout(check, 1500);
    try {
      setDismissed(sessionStorage.getItem("botseal.gate.dismissed") === "1");
    } catch {
      /* sessionStorage may be unavailable; default to showing the banner */
    }
    return () => clearTimeout(t);
  }, []);

  if (!outside || dismissed) return null;

  return (
    <div className="border-b border-accent/25 bg-accent/[0.08]">
      <div className="mx-auto flex max-w-5xl items-start gap-3 px-4 py-2.5 sm:px-6">
        <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <p className="flex-1 text-xs leading-5 text-foreground/80">
          You&apos;re viewing BotSeal in a browser. Open it inside{" "}
          <span className="font-semibold text-foreground">Nimiq Pay → Mini Apps</span> to create,
          seal, and pay invoices with your wallet.
        </p>
        <CopyButton value={url} label="app link" />
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            setDismissed(true);
            try {
              sessionStorage.setItem("botseal.gate.dismissed", "1");
            } catch {
              /* ignore */
            }
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/50 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
