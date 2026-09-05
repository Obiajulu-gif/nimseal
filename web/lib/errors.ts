/**
 * Translates contract custom errors and wallet failures into messages a user can act on.
 *
 * Nothing here echoes invoice content: the escrow's errors are all about addresses, status, and
 * amount, and the attestor's rejection strings name a field and a rule, never a value.
 */

import { settlementChain } from "./chain";

/** Custom error name -> user-facing explanation. Keys match `NimSealEscrow`'s error selectors. */
const ESCROW_ERRORS: Record<string, string> = {
  ZeroAddress: "That address cannot be zero.",
  NotAContract: "That address does not contain a contract.",
  InvalidAmount: "The invoice amount must be greater than zero.",
  InvalidDueDate: "The due date must be in the future.",
  InvalidCommitment: "The terms commitment is missing.",
  InvoiceNotFound: "No invoice exists with that id.",
  InvalidStatus: "This invoice is not in the right state for that action.",
  NotSeller: "Only the seller can do that.",
  NotBuyer: "Only the buyer can do that.",
  InvoiceExpired: "This invoice is past its due date and can no longer be funded.",
  RefundNotAvailable: "The refund grace period has not elapsed yet.",
  AttestorNotConfigured: "The escrow has no attestor signing address configured yet.",
  InvalidAttestorSignature:
    "The attestor signature on this result is not valid for this escrow and chain.",
  AttestationAlreadyConsumed:
    "This confidential result has already been used to create an invoice.",
  InvalidResultSeller: "Only the seller named in the confidential result can relay it.",
  InvalidAttestationId: "The attestation id is missing.",
  SameSellerAndBuyer: "The buyer must be different from the seller.",
  CannotRecoverEscrowToken: "Escrowed funds cannot be moved by the owner.",
  UnsupportedTokenDecimals: "The token reports an unsupported number of decimals.",
  EnforcedPause: "The contract is paused.",
  OwnableUnauthorizedAccount: "Only the contract owner can do that.",
};

/** ERC-20 failures surface as plain reverts; these substrings are the common ones. */
const TOKEN_HINTS: Array<[RegExp, string]> = [
  [
    /insufficient allowance|ERC20InsufficientAllowance/i,
    "Approve the settlement token for the escrow first.",
  ],
  [/insufficient balance|ERC20InsufficientBalance/i, "Your token balance is too low."],
  [/transfer amount exceeds balance/i, "Your token balance is too low."],
];

// Name the network this build is actually pinned to, with its chain id. "Switch networks" is worse
// than useless on a testnet build: the user follows it to production, which is a different chain
// with a different escrow, and the transaction fails again for a new reason.
const TARGET = `${settlementChain.name} (chain ${settlementChain.id})`;

const WALLET_HINTS: Array<[RegExp, string]> = [
  [/user rejected|user denied|ACTION_REJECTED|4001/i, "You cancelled the request in Nimiq Pay. No transaction was sent."],
  [
    /insufficient funds for gas|insufficient funds for intrinsic/i,
    `Not enough ${settlementChain.nativeCurrency.symbol} in your Nimiq Pay wallet to pay for gas.`,
  ],
  [
    /chain mismatch|chain not configured|ChainMismatchError|does not match the target chain/i,
    `Your wallet is on the wrong network. Switch it to ${TARGET} and try again.`,
  ],
  // Seen when a wallet left on another network tries to send: that chain's RPC estimates gas
  // against an account with a zero balance there. The message names gas, but the cause is almost
  // always the network, so it is worth saying both.
  [
    /gas required exceeds allowance|exceeds allowance \(0\)|cannot estimate gas/i,
    `The transaction could not be estimated. Check your wallet is on ${TARGET} and holds ` +
      `${settlementChain.nativeCurrency.symbol} for gas.`,
  ],
  [/nonce too low|replacement transaction underpriced/i, "A pending transaction is in the way."],
  [/timeout|timed out/i, "The network did not respond in time. Try again."],
];

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    // viem nests the useful text; `shortMessage` and `details` are the readable layers.
    const viemError = error as Error & { shortMessage?: string; details?: string };
    return [viemError.shortMessage, viemError.details, error.message]
      .filter(Boolean)
      .join(" | ");
  }
  if (typeof error === "object" && error !== null) {
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Produces a single sentence suitable for a toast.
 *
 * Falls back to a generic message rather than dumping raw RPC output, which is long and can carry
 * calldata a user should not be asked to read.
 */
export function explainError(error: unknown): string {
  const raw = messageOf(error);

  for (const [name, explanation] of Object.entries(ESCROW_ERRORS)) {
    // viem renders custom errors as `Error: Name()` or `reverted with ... Name()`.
    if (new RegExp(`\\b${name}\\b`).test(raw)) return explanation;
  }

  for (const [pattern, explanation] of [...TOKEN_HINTS, ...WALLET_HINTS]) {
    if (pattern.test(raw)) return explanation;
  }

  if (error instanceof Error) {
    const short = (error as Error & { shortMessage?: string }).shortMessage;
    if (short && short.length < 160) return short;
  }

  return "The transaction failed. Check the console for details and try again.";
}
