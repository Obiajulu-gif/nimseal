/**
 * Environment validation.
 *
 * Public (`NEXT_PUBLIC_*`) values are inlined into the browser bundle at build time, so they are
 * read through an explicit literal map — `process.env[someVariable]` is not statically analysable
 * and would come back undefined in the client.
 *
 * The attestor's key and escrow binding are deliberately absent from this module. They are
 * server-only and live in `lib/attestor/signer.ts`, which imports `server-only` so that pulling
 * them into a client component is a build error rather than a leak.
 */

import { z } from "zod";

const POLYGON_CHAIN_ID = 137;
const SEPOLIA_CHAIN_ID = 11155111;

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");

/** An address that may be blank before deployment; blank normalises to `undefined`. */
const optionalAddress = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? undefined : value))
  .pipe(addressSchema.optional());

/** An optional URL; blank normalises to `undefined` so the chain default is used. */
const optionalUrl = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? undefined : value))
  .pipe(z.string().url().optional());

const booleanish = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase() === "true");

const publicSchema = z.object({
  chainId: z
    .string()
    .trim()
    .transform((value) => (value.length === 0 ? POLYGON_CHAIN_ID : Number(value)))
    .pipe(
      z
        .number()
        .int()
        .refine(
          (id) => id === POLYGON_CHAIN_ID || id === SEPOLIA_CHAIN_ID,
          `must be ${POLYGON_CHAIN_ID} (Polygon) or ${SEPOLIA_CHAIN_ID} (Sepolia)`,
        ),
    ),
  rpcUrl: optionalUrl,
  explorerUrl: optionalUrl,
  escrowAddress: optionalAddress,
  settlementTokenAddress: optionalAddress,
  enablePublicMode: booleanish,
});

export type PublicEnv = z.infer<typeof publicSchema>;

function readPublicEnv(): PublicEnv {
  const parsed = publicSchema.safeParse({
    // Accept the legacy NEXT_PUBLIC_CHAIN_ID name as a fallback so older env files keep working.
    chainId: process.env.NEXT_PUBLIC_EVM_CHAIN_ID ?? process.env.NEXT_PUBLIC_CHAIN_ID ?? "",
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "",
    explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL ?? "",
    escrowAddress: process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? "",
    settlementTokenAddress: process.env.NEXT_PUBLIC_SETTLEMENT_TOKEN_ADDRESS ?? "",
    enablePublicMode: process.env.NEXT_PUBLIC_ENABLE_PUBLIC_MODE ?? "false",
  });

  if (!parsed.success) {
    // Malformed public config is a build-time mistake, not a runtime condition to recover from.
    const detail = parsed.error.issues
      .map((issue) => `  NEXT_PUBLIC_${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid public environment configuration:\n${detail}`);
  }

  return parsed.data;
}

export const env: PublicEnv = readPublicEnv();

/** True once the escrow address is configured; pages gate their write actions on this. */
export const isEscrowConfigured = env.escrowAddress !== undefined;

/** True once the settlement token is configured. */
export const isSettlementTokenConfigured = env.settlementTokenAddress !== undefined;
