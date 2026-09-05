"use client";

/**
 * EVM wallet access through Nimiq Pay, network status, and the network guard.
 *
 * Inside Nimiq Pay the EVM wallet is injected at `window.ethereum` and discovered over EIP-6963, so
 * wagmi's injected connector reaches it with no extension, no WalletConnect, and no MetaMask. The
 * wrong-network banner is persistent and every settlement button is disabled until the wallet is on
 * the configured chain — a write sent to the wrong chain would either revert or, worse, hit a
 * different contract at the same address.
 */

import Link from "next/link";
import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { settlementChain, isTestnet } from "@/lib/chain";
import { addressUrl, shortenHex } from "@/lib/explorer";
import {
  formatTokenAmount,
  useSettlementTokenBalance,
  useSettlementTokenMetadata,
} from "@/hooks/use-settlement-token";
import { Alert, Badge, Button } from "@/components/ui/primitives";
import { CopyButton } from "@/components/common";
import { BrandMark } from "@/components/brand";

/**
 * The chain the wallet is *actually* on.
 *
 * Deliberately not `useChainId()`. That hook reads the chain from the wagmi config, which declares
 * exactly one chain, so it always returns {@link settlementChain.id} regardless of the wallet's
 * real network. `useAccount().chainId` is the connector's chain — what viem actually checks before
 * a write — and is `undefined` while disconnected.
 */
function useWalletChainId(): number | undefined {
  return useAccount().chainId;
}

export function useOnCorrectNetwork(): boolean {
  const { isConnected } = useAccount();
  const chainId = useWalletChainId();
  return isConnected && chainId === settlementChain.id;
}

/**
 * The primary wallet control.
 *
 * Copy is written for the Nimiq Pay host rather than a generic dApp: there is no "install a wallet"
 * dead end, because Nimiq Pay *is* the wallet. The connect action follows an explicit user gesture
 * and triggers `eth_requestAccounts` through the injected provider.
 */
export function ConnectButton({ full = false }: { full?: boolean }) {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  const injectedConnector = connectors.find((c) => c.type === "injected") ?? connectors[0];

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <a
          href={addressUrl(address)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 font-mono text-xs text-foreground/70 transition-colors hover:border-primary/30 hover:bg-white/[0.07] hover:text-foreground"
        >
          {shortenHex(address)}
        </a>
        <Button variant="ghost" size="sm" onClick={() => disconnect()}>
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <Button
      size={full ? "lg" : "sm"}
      className={full ? "w-full" : undefined}
      disabled={isPending || !injectedConnector}
      onClick={() => injectedConnector && connect({ connector: injectedConnector })}
    >
      {isPending ? "Connecting…" : "Enable wallet access"}
    </Button>
  );
}

const NETWORK_LABEL = isTestnet ? `${settlementChain.name} · testnet` : settlementChain.name;

export function NetworkBadge() {
  const { isConnected } = useAccount();
  const chainId = useWalletChainId();

  if (!isConnected) return <Badge variant="neutral">Not connected</Badge>;
  if (chainId === settlementChain.id) return <Badge variant="success">{NETWORK_LABEL}</Badge>;
  return <Badge variant="danger">Wrong network{chainId ? ` · chain ${chainId}` : ""}</Badge>;
}

/**
 * The connected wallet's settlement-token and gas balances.
 *
 * A buyer needs to know they can cover the invoice before an approve/fund sequence; a seller wants
 * to see the money arrive on release. The settlement-token balance is the headline because that is
 * what invoices settle in; the native balance is shown second and only matters for gas.
 */
export function WalletBalances() {
  const { address, isConnected } = useAccount();
  const onCorrectNetwork = useOnCorrectNetwork();

  const { symbol, decimals } = useSettlementTokenMetadata();
  const tokenBalance = useSettlementTokenBalance(address);
  const nativeBalance = useBalance({
    address,
    chainId: settlementChain.id,
    query: { enabled: Boolean(address) },
  });

  if (!isConnected || !address || !onCorrectNetwork) return null;

  const token =
    tokenBalance.data !== undefined && decimals !== undefined
      ? `${formatTokenAmount(tokenBalance.data, decimals, 2)} ${symbol}`
      : "—";

  const native = nativeBalance.data
    ? `${formatTokenAmount(nativeBalance.data.value, nativeBalance.data.decimals, 4)} ${
        nativeBalance.data.symbol
      }`
    : "—";

  return (
    <div
      className="hidden items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 lg:flex"
      title={`Settlement balance ${token} · gas balance ${native}`}
    >
      <span className="font-mono text-xs font-medium text-foreground/90">{token}</span>
      <span aria-hidden="true" className="h-3 w-px bg-white/15" />
      <span className="font-mono text-xs text-foreground/50">{native}</span>
    </div>
  );
}

/**
 * Persistent banner shown whenever the wallet is connected to the wrong chain.
 * Renders nothing when disconnected — that state is handled per page.
 */
export function WrongNetworkBanner() {
  const { isConnected } = useAccount();
  const chainId = useWalletChainId();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected || chainId === settlementChain.id) return null;

  return (
    <div className="border-b border-destructive/30 bg-destructive/10 backdrop-blur-xl">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <p className="text-sm text-red-200">
          {chainId === undefined
            ? "Your wallet has not reported a network yet."
            : `Your Nimiq Pay wallet is on chain ${chainId}.`}{" "}
          Switch to {settlementChain.name} to continue. All actions are disabled.
        </p>
        <Button
          size="sm"
          variant="destructive"
          disabled={isPending}
          onClick={() => switchChain({ chainId: settlementChain.id })}
        >
          {isPending ? "Switching…" : `Switch to ${settlementChain.name}`}
        </Button>
      </div>
    </div>
  );
}

/**
 * Wraps page content that requires a connected wallet on the settlement chain, rendering an
 * explanatory placeholder otherwise.
 */
export function RequireWallet({ children }: { children: React.ReactNode }) {
  const { isConnected } = useAccount();
  const chainId = useWalletChainId();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected) {
    return (
      <Alert tone="info" title="Wallet access needed">
        <p className="mb-3">
          Give BotSeal permission to use your Nimiq Pay wallet on {settlementChain.name} to continue.
        </p>
        <ConnectButton full />
      </Alert>
    );
  }

  if (chainId !== settlementChain.id) {
    return (
      <Alert tone="warning" title="Wrong network">
        <p className="mb-3">
          Switch your Nimiq Pay wallet to {settlementChain.name} (chain {settlementChain.id}) to
          continue.
        </p>
        <Button size="sm" disabled={isPending} onClick={() => switchChain({ chainId: settlementChain.id })}>
          {isPending ? "Switching…" : `Switch to ${settlementChain.name}`}
        </Button>
      </Alert>
    );
  }

  return <>{children}</>;
}

/**
 * Compact top bar. Navigation lives in the bottom bar on mobile ({@link BottomNav}); the header
 * keeps only the brand and the wallet chip so the settlement context is always one glance away.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-background/80 backdrop-blur-2xl">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link href="/" aria-label="BotSeal home" className="flex items-center gap-2.5">
          <BrandMark className="h-8 w-8" />
          <span className="font-display text-base font-semibold tracking-[-0.02em]">BotSeal</span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          <WalletBalances />
          <div className="hidden sm:block">
            <NetworkBadge />
          </div>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}

/** Small helper re-exported for pages that show the connected EVM address with copy. */
export function ConnectedAddress() {
  const { address } = useAccount();
  if (!address) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <a href={addressUrl(address)} target="_blank" rel="noopener noreferrer" className="hex">
        {shortenHex(address)}
      </a>
      <CopyButton value={address} label="wallet address" />
    </span>
  );
}
