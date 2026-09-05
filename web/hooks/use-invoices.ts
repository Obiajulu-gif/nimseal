"use client";

/**
 * Invoice reads and the settlement writes.
 *
 * Every write goes through {@link useEscrowWrite}, which owns the shared shape: simulate where it
 * helps, submit, wait for the receipt, surface a toast with an explorer link, then invalidate the
 * relevant queries so the UI reflects the new on-chain state.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { Hex } from "viem";
import { useAccount, useConfig, useReadContract, useReadContracts } from "wagmi";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";

import { escrowAbi, escrowAddress, type Invoice } from "@/lib/contracts";
import { explainError } from "@/lib/errors";
import { env } from "@/lib/env";
import { txUrl } from "@/lib/explorer";
import { settlementChain } from "@/lib/chain";

/** Ids where the connected address is the seller. */
export function useSellerInvoiceIds(address?: Hex) {
  return useReadContract({
    abi: escrowAbi,
    address: env.escrowAddress as Hex | undefined,
    functionName: "getSellerInvoiceIds",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && env.escrowAddress) },
  });
}

/** Ids where the connected address is the buyer. */
export function useBuyerInvoiceIds(address?: Hex) {
  return useReadContract({
    abi: escrowAbi,
    address: env.escrowAddress as Hex | undefined,
    functionName: "getBuyerInvoiceIds",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && env.escrowAddress) },
  });
}

/**
 * Reads the escrow's configured attestor signing address.
 *
 * Until the owner has called `setAttestorAddress`, `relayConfidentialInvoice` reverts with
 * `AttestorNotConfigured`. Without this check the UI would take a seller all the way through
 * encryption and attestation toward a relay that cannot succeed.
 */
export function useAttestorAddress() {
  return useReadContract({
    abi: escrowAbi,
    address: env.escrowAddress as Hex | undefined,
    functionName: "attestorAddress",
    query: { enabled: Boolean(env.escrowAddress), staleTime: 30_000 },
  });
}

/** True only when the escrow will accept an attestor-signed result. */
export function useConfidentialAvailable(): { available: boolean; isLoading: boolean } {
  const { data, isLoading } = useAttestorAddress();
  const attestorConfigured = typeof data === "string" && data.toLowerCase() !== ZERO_ADDRESS;

  return { available: attestorConfigured, isLoading };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Fetches one invoice struct. */
export function useInvoice(invoiceId?: bigint) {
  return useReadContract({
    abi: escrowAbi,
    address: env.escrowAddress as Hex | undefined,
    functionName: "getInvoice",
    args: invoiceId !== undefined ? [invoiceId] : undefined,
    query: {
      enabled: invoiceId !== undefined && Boolean(env.escrowAddress),
      retry: false, // A missing invoice reverts with InvoiceNotFound; retrying cannot help.
    },
  });
}

/** Batch-fetches invoice structs for the dashboard. */
export function useInvoices(ids: bigint[]) {
  const address = env.escrowAddress as Hex | undefined;

  const result = useReadContracts({
    contracts: ids.map((id) => ({
      abi: escrowAbi,
      address,
      functionName: "getInvoice" as const,
      args: [id] as const,
    })),
    query: { enabled: ids.length > 0 && Boolean(address) },
  });

  const invoices = (result.data ?? [])
    .map((entry) => (entry.status === "success" ? (entry.result as unknown as Invoice) : undefined))
    .filter((invoice): invoice is Invoice => invoice !== undefined);

  return { ...result, invoices };
}

/** Merges the seller and buyer id lists into one deduplicated, descending list. */
export function mergeInvoiceIds(seller?: readonly bigint[], buyer?: readonly bigint[]): bigint[] {
  const merged = new Set<bigint>([...(seller ?? []), ...(buyer ?? [])]);
  return Array.from(merged).sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
}

// --- Writes ------------------------------------------------------------------

export type EscrowFunction =
  | "fundInvoice"
  | "releasePayment"
  | "refundBuyer"
  | "claimExpiredRefund"
  | "cancelInvoice"
  | "createPublicInvoice"
  | "relayConfidentialInvoice";

interface WriteRequest {
  functionName: EscrowFunction;
  args: readonly unknown[];
  /** Shown in the success toast. */
  successMessage: string;
}

/**
 * Runs an escrow write to completion and reports the outcome.
 *
 * Returns the receipt so callers can read logs (the relay flow needs `InvoiceCreated`).
 */
export function useEscrowWrite() {
  const config = useConfig();
  const queryClient = useQueryClient();
  const [txHash, setTxHash] = useState<Hex | undefined>();

  const mutation = useMutation({
    mutationFn: async ({ functionName, args }: WriteRequest) => {
      setTxHash(undefined);

      const hash = await writeContract(config, {
        // Pinning the chain makes a wrong-network send impossible: wagmi throws
        // ChainMismatchError before broadcasting instead of submitting to whatever chain the
        // wallet happens to be on. Without this, a wallet left on Ethereum mainnet sends there
        // and the user gets a raw "gas required exceeds allowance (0)" from the mainnet RPC.
        chainId: settlementChain.id,
        abi: escrowAbi,
        address: escrowAddress(),
        functionName,
        args,
      });
      setTxHash(hash);

      const receipt = await waitForTransactionReceipt(config, { hash });
      if (receipt.status !== "success") {
        throw new Error("The transaction reverted on-chain.");
      }
      return receipt;
    },
    onSuccess: (receipt, variables) => {
      toast.success(variables.successMessage, {
        description: `View on ${settlementChain.name} explorer`,
        action: {
          label: "Open",
          onClick: () => window.open(txUrl(receipt.transactionHash), "_blank", "noopener"),
        },
      });
      // Invalidate every contract read; the affected set differs per action and reads are cheap.
      void queryClient.invalidateQueries();
    },
    onError: (error) => {
      toast.error(explainError(error));
    },
  });

  return { ...mutation, txHash };
}

/** Convenience wrappers so pages read declaratively. */
export function useSettlementActions(invoiceId?: bigint) {
  const write = useEscrowWrite();

  const run = useCallback(
    (functionName: EscrowFunction, successMessage: string, extraArgs: readonly unknown[] = []) => {
      if (invoiceId === undefined) return;
      write.mutate({ functionName, args: [invoiceId, ...extraArgs], successMessage });
    },
    [invoiceId, write],
  );

  return {
    ...write,
    fund: () => run("fundInvoice", "Invoice funded."),
    release: () => run("releasePayment", "Payment released to the seller."),
    refund: () => run("refundBuyer", "Escrow refunded to the buyer."),
    claimExpired: () => run("claimExpiredRefund", "Expired escrow reclaimed."),
    cancel: () => run("cancelInvoice", "Invoice cancelled."),
  };
}

/** True when the connected wallet is the invoice's buyer. */
export function useIsBuyer(invoice?: Invoice): boolean {
  const { address } = useAccount();
  return Boolean(address && invoice && address.toLowerCase() === invoice.buyer.toLowerCase());
}

/** True when the connected wallet is the invoice's seller. */
export function useIsSeller(invoice?: Invoice): boolean {
  const { address } = useAccount();
  return Boolean(address && invoice && address.toLowerCase() === invoice.seller.toLowerCase());
}
