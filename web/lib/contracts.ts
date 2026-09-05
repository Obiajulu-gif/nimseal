/**
 * Contract addresses, ABIs, and the shared on-chain enums.
 *
 * Addresses come from the validated environment. Reading one that has not been configured throws
 * with an actionable message rather than sending a transaction to `0x0`.
 */

import type { Abi, Hex } from "viem";

import escrowAbiJson from "./abi/NimSealEscrow.json";
import { env } from "./env";

export const escrowAbi = escrowAbiJson as Abi;

/** Minimal ERC-20 surface. The settlement token is a standard ERC-20. */
export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const satisfies Abi;

export class MissingAddressError extends Error {
  constructor(variable: string) {
    super(
      `${variable} is not configured. Deploy the contracts and set it in web/.env.local — see docs/DEPLOYMENT.md.`,
    );
    this.name = "MissingAddressError";
  }
}

export function escrowAddress(): Hex {
  if (!env.escrowAddress) throw new MissingAddressError("NEXT_PUBLIC_ESCROW_ADDRESS");
  return env.escrowAddress as Hex;
}

export function settlementTokenAddress(): Hex {
  if (!env.settlementTokenAddress) {
    throw new MissingAddressError("NEXT_PUBLIC_SETTLEMENT_TOKEN_ADDRESS");
  }
  return env.settlementTokenAddress as Hex;
}

// --- Invoice status ----------------------------------------------------------

/** Mirrors `NimSealEscrow.InvoiceStatus`. Order is significant. */
export enum InvoiceStatus {
  None = 0,
  Pending = 1,
  Funded = 2,
  Released = 3,
  Refunded = 4,
  Cancelled = 5,
}

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  [InvoiceStatus.None]: "Unknown",
  [InvoiceStatus.Pending]: "Pending",
  [InvoiceStatus.Funded]: "Funded",
  [InvoiceStatus.Released]: "Released",
  [InvoiceStatus.Refunded]: "Refunded",
  [InvoiceStatus.Cancelled]: "Cancelled",
};

export function invoiceStatusLabel(status: number): string {
  return INVOICE_STATUS_LABELS[status as InvoiceStatus] ?? "Unknown";
}

/** The on-chain `Invoice` struct as viem decodes it. */
export interface Invoice {
  id: bigint;
  seller: Hex;
  buyer: Hex;
  termsCommitment: Hex;
  attestationId: Hex;
  usdAmountCents: bigint;
  tokenAmount: bigint;
  dueAt: bigint;
  createdAt: bigint;
  fundedAt: bigint;
  settledAt: bigint;
  confidential: boolean;
  status: number;
}

export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
