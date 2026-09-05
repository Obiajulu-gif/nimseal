import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";

import { Providers } from "./providers";
import { SiteHeader, WrongNetworkBanner } from "@/components/wallet";
import { BottomNav } from "@/components/nav";
import "./globals.css";

const bodyFont = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const displayFont = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "nimSeal — confidential invoices for Nimiq Pay",
    template: "%s — nimSeal",
  },
  description:
    "Create confidential invoices, seal them with your Nimiq wallet, and settle in USDT through Nimiq Pay.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0b0e15",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bodyFont.variable} ${displayFont.variable}`}>
      <body className="overflow-x-hidden">
        <Providers>
          <WrongNetworkBanner />
          <SiteHeader />
          <main className="mx-auto min-h-[calc(100vh-9rem)] max-w-5xl px-4 pb-28 pt-6 sm:px-6 sm:pb-16 sm:pt-10">
            {children}
          </main>
          <footer className="mx-auto max-w-5xl px-4 pb-24 pt-6 text-xs text-muted-foreground sm:px-6 sm:pb-10">
            <div className="section-rule mb-5 h-px" />
            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
              <p>nimSeal · Private terms. Protected settlement.</p>
              <p className="opacity-60">Nimiq Pay Mini App · Experimental · Unaudited</p>
            </div>
          </footer>
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}
