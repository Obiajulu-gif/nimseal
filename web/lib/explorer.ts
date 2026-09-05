/**
 * Block-explorer URL construction for the active EVM settlement chain.
 *
 * The base URL comes from the chain definition (Polygonscan, Sepolia Etherscan) or a configured
 * override. Trailing slashes are normalised so `.../tx//0x…` can never be produced.
 */

import { explorerBaseUrl } from "./chain";

export function txUrl(hash: string): string {
  return `${explorerBaseUrl()}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${explorerBaseUrl()}/address/${address}`;
}

export function blockUrl(block: bigint | number): string {
  return `${explorerBaseUrl()}/block/${block.toString()}`;
}

/** Shortens a hash or address for display: `0x1234…cdef`. */
export function shortenHex(value: string, lead = 6, tail = 4): string {
  if (!value.startsWith("0x")) return value;
  if (value.length <= lead + tail + 2) return value;
  return `${value.slice(0, 2 + lead)}…${value.slice(-tail)}`;
}
