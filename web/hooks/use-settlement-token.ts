"use client";

/**
 * Settlement-token reads, the invoice quote, and the approval write.
 *
 * The quote is a plain contract read. In the oracle-priced build this replaces it had to be a
 * `simulateContract` call against a `payable` quote function that could return a different number
 * a block later. With stablecoin settlement the amount due is fixed when the invoice is created,
 * so there is no price to age out, no refetch interval, and no slippage ceiling to choose.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Hex } from "viem";
import { useReadContract, useConfig } from "wagmi";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";

import { erc20Abi, escrowAbi, escrowAddress, settlementTokenAddress } from "@/lib/contracts";
import { env } from "@/lib/env";
import { explainError } from "@/lib/errors";
import { txUrl } from "@/lib/explorer";
import { settlementChain } from "@/lib/chain";

const token = () => env.settlementTokenAddress as Hex | undefined;

export function useSettlementTokenMetadata() {
  const address = token();

  const symbol = useReadContract({
    abi: erc20Abi,
    address,
    functionName: "symbol",
    query: { enabled: Boolean(address), staleTime: Infinity },
  });

  const decimals = useReadContract({
    abi: erc20Abi,
    address,
    functionName: "decimals",
    query: { enabled: Boolean(address), staleTime: Infinity },
  });

  return {
    symbol: symbol.data ?? "USDT",
    decimals: decimals.data,
    isLoading: symbol.isLoading || decimals.isLoading,
  };
}

export function useSettlementTokenBalance(owner?: Hex) {
  const address = token();
  return useReadContract({
    abi: erc20Abi,
    address,
    functionName: "balanceOf",
    args: owner ? [owner] : undefined,
    query: { enabled: Boolean(address && owner) },
  });
}

export function useSettlementTokenAllowance(owner?: Hex) {
  const address = token();
  return useReadContract({
    abi: erc20Abi,
    address,
    functionName: "allowance",
    args: owner && env.escrowAddress ? [owner, env.escrowAddress as Hex] : undefined,
    query: { enabled: Boolean(address && owner && env.escrowAddress) },
  });
}

/**
 * Reads the exact settlement-token amount required to fund an invoice.
 *
 * The answer is deterministic for the life of the invoice, so it is cached indefinitely: a
 * refetch could not return anything different.
 */
export function useInvoiceQuote(invoiceId?: bigint, enabled = true) {
  return useReadContract({
    abi: escrowAbi,
    address: env.escrowAddress as Hex | undefined,
    functionName: "quoteInvoice",
    args: invoiceId !== undefined ? [invoiceId] : undefined,
    chainId: settlementChain.id,
    query: {
      enabled: enabled && invoiceId !== undefined && Boolean(env.escrowAddress),
      staleTime: Infinity,
      retry: false,
    },
  });
}

/**
 * Approves the settlement token for the escrow.
 *
 * Approves the exact amount the buyer is about to spend — never an unlimited allowance — and
 * re-reads the allowance once the receipt confirms.
 */
export function useApproveSettlementToken() {
  const config = useConfig();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (amount: bigint) => {
      const hash = await writeContract(config, {
        // See the note in use-invoices.ts: pinning the chain turns a wrong-network send into a
        // clear pre-flight error instead of a failed transaction on another chain.
        chainId: settlementChain.id,
        abi: erc20Abi,
        address: settlementTokenAddress(),
        functionName: "approve",
        args: [escrowAddress(), amount],
      });

      const receipt = await waitForTransactionReceipt(config, { hash });
      if (receipt.status !== "success") {
        throw new Error("The approval transaction reverted.");
      }
      return receipt;
    },
    onSuccess: (receipt) => {
      toast.success("Settlement token approved.", {
        description: `View on ${settlementChain.name} explorer`,
        action: {
          label: "Open",
          onClick: () => window.open(txUrl(receipt.transactionHash), "_blank", "noopener"),
        },
      });
      void queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(explainError(error)),
  });
}

/** Formats a base-unit token amount for display, trimming trailing zeros. */
export function formatTokenAmount(amount: bigint, decimals: number, precision = 6): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = amount % scale;
  if (fraction === 0n) return whole.toString();

  const padded = fraction.toString().padStart(decimals, "0").slice(0, precision).replace(/0+$/, "");
  return padded.length > 0 ? `${whole}.${padded}` : whole.toString();
}
