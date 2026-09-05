"use client";

/**
 * Mobile-first bottom navigation. A thumb-reachable tab bar is the native pattern inside a Nimiq
 * Pay WebView; the desktop header keeps the same destinations available on wider screens.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FilePlus2, Home, LayoutDashboard, type LucideIcon } from "lucide-react";

const TABS: Array<{ href: string; label: string; icon: LucideIcon; match: (p: string) => boolean }> = [
  { href: "/", label: "Home", icon: Home, match: (p) => p === "/" },
  {
    href: "/dashboard",
    label: "Invoices",
    icon: LayoutDashboard,
    match: (p) => p.startsWith("/dashboard") || p.startsWith("/invoices/") || p.startsWith("/pay/"),
  },
  { href: "/invoices/new", label: "Create", icon: FilePlus2, match: (p) => p === "/invoices/new" },
];

export function BottomNav() {
  const pathname = usePathname() ?? "/";

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-white/[0.08] bg-background/90 backdrop-blur-2xl pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="mx-auto flex max-w-md items-stretch justify-around">
        {TABS.map(({ href, label, icon: Icon, match }) => {
          const active = match(pathname);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-[3.75rem] flex-col items-center justify-center gap-1 text-[0.68rem] font-medium transition-colors ${
                  active ? "text-primary" : "text-foreground/50 hover:text-foreground/80"
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
