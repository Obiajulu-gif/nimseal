"use client";

/**
 * The confidential invoice creation state machine.
 *
 *   idle → loading-attestor-info → encrypting → attesting
 *        → awaiting-wallet-signature → relaying-result → confirmed
 *
 * This is two steps shorter than the build it replaces. That version paid for an on-chain
 * instruction transaction, then polled a proxy until an enclave picked the instruction up and
 * returned a result. The attestor is reachable directly, so the seller signs one transaction
 * instead of two, and there is nothing to poll.
 *
 * Privacy rules enforced here:
 *   - The plaintext payload exists only as a local `const` inside {@link create}. It is never put in
 *     React state, localStorage, a URL, a toast, or a log line.
 *   - The nonce and salt are generated per invoice and dropped with the payload.
 *   - Errors surfaced to the UI describe the step that failed, never the invoice content.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeEventLog, type Hex, type TransactionReceipt } from "viem";
import { useConfig } from "wagmi";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";

import { escrowAbi } from "@/lib/contracts";
import { explainError } from "@/lib/errors";
import { settlementChain } from "@/lib/chain";
import {
  deserialiseAttestation,
  encryptToAttestor,
  type AttestorCreateResponse,
  type AttestorInfo,
  type ConfidentialAttestation,
} from "@/lib/attestor";
import type { PrivateInvoicePayload } from "@/lib/invoice";

export type ConfidentialPhase =
  | "idle"
  | "loading-attestor-info"
  | "encrypting"
  | "attesting"
  | "awaiting-wallet-signature"
  | "relaying-result"
  | "confirmed";

export type ConfidentialErrorKind =
  | "attestor-unavailable"
  | "wallet-rejected"
  | "attestor-rejected"
  | "relay-reverted"
  | "wrong-network";

export interface ConfidentialError {
  kind: ConfidentialErrorKind;
  message: string;
}

export interface ConfidentialState {
  phase: ConfidentialPhase;
  error?: ConfidentialError;
  /** Populated as the flow progresses, for the transaction receipts panel. */
  attestationId?: Hex;
  relayTxHash?: Hex;
  invoiceId?: bigint;
}

const INITIAL: ConfidentialState = { phase: "idle" };

/** Human-readable label per phase, used by the progress UI. */
export const PHASE_LABELS: Record<ConfidentialPhase, string> = {
  idle: "Ready",
  "loading-attestor-info": "Fetching the attestor's public key…",
  encrypting: "Encrypting the invoice in your browser…",
  attesting: "The attestor is validating and signing…",
  "awaiting-wallet-signature": "Waiting for you to confirm in your wallet…",
  "relaying-result": "Relaying the signed result into the escrow…",
  confirmed: "Confidential invoice created.",
};

async function fetchAttestorInfo(signal: AbortSignal): Promise<AttestorInfo> {
  const response = await fetch("/api/attestor/info", { signal, cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? "The attestor service is unavailable.");
  }
  return (await response.json()) as AttestorInfo;
}

export function useConfidentialInvoice() {
  const config = useConfig();
  const [state, setState] = useState<ConfidentialState>(INITIAL);
  const abortRef = useRef<AbortController | undefined>(undefined);

  // Stop any in-flight request if the component unmounts mid-flow.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(INITIAL);
  }, []);

  /**
   * Runs the full flow. `payload` is consumed immediately and never retained.
   *
   * @returns the new invoice id on success, or `undefined` if the flow failed.
   */
  const create = useCallback(
    async (payload: PrivateInvoicePayload): Promise<bigint | undefined> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const fail = (kind: ConfidentialErrorKind, message: string) => {
        setState((prev) => ({ ...prev, error: { kind, message } }));
        return undefined;
      };

      try {
        // --- 1. Attestor public key ------------------------------------------
        setState({ phase: "loading-attestor-info" });
        let info: AttestorInfo;
        try {
          info = await fetchAttestorInfo(controller.signal);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return undefined;
          return fail(
            "attestor-unavailable",
            error instanceof Error ? error.message : "The attestor service is unavailable.",
          );
        }

        if (info.chainId !== settlementChain.id) {
          return fail(
            "wrong-network",
            `The attestor is configured for chain ${info.chainId}, but this app is on ` +
              `chain ${settlementChain.id}. A signature minted for another chain cannot be relayed here.`,
          );
        }
        if (info.escrowContract.toLowerCase() !== payload.escrowContract.toLowerCase()) {
          return fail(
            "attestor-unavailable",
            "The attestor is bound to a different escrow than this app is configured with.",
          );
        }

        // --- 2. Encrypt in the browser ----------------------------------------
        setState((prev) => ({ ...prev, phase: "encrypting" }));
        let ciphertext: Hex;
        try {
          // The only place the plaintext is serialised. Both the JSON string and `payload` go out
          // of scope when this function returns.
          ciphertext = await encryptToAttestor(info.publicKey, JSON.stringify(payload));
        } catch {
          return fail(
            "attestor-unavailable",
            "Could not encrypt the invoice to the attestor's key.",
          );
        }

        // --- 3. Validate and sign, server-side --------------------------------
        setState((prev) => ({ ...prev, phase: "attesting" }));
        let attestation: ConfidentialAttestation;
        let signature: Hex;
        try {
          const response = await fetch("/api/attestor/create", {
            method: "POST",
            signal: controller.signal,
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ciphertext }),
          });

          const body = (await response.json()) as AttestorCreateResponse;
          if (!response.ok || !body.ok) {
            const message = body.ok ? "The attestor rejected this invoice." : body.message;
            // A 422 is the invoice failing validation; anything else is the service itself.
            return fail(
              response.status === 422 ? "attestor-rejected" : "attestor-unavailable",
              message,
            );
          }

          attestation = deserialiseAttestation(body.attestation);
          signature = body.signature;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return undefined;
          return fail("attestor-unavailable", "Could not reach the attestor service.");
        }

        setState((prev) => ({ ...prev, attestationId: attestation.attestationId }));

        // --- 4. Relay the signed attestation ----------------------------------
        setState((prev) => ({ ...prev, phase: "awaiting-wallet-signature" }));
        let relayReceipt: TransactionReceipt;
        try {
          const hash = await writeContract(config, {
            // Pinned so a relay can never be paid for on the wrong chain.
            chainId: settlementChain.id,
            abi: escrowAbi,
            address: payload.escrowContract,
            functionName: "relayConfidentialInvoice",
            // Passed exactly as signed. Changing any field invalidates the EIP-712 digest and the
            // on-chain check reverts with InvalidAttestorSignature.
            args: [attestation, signature],
          });

          setState((prev) => ({ ...prev, phase: "relaying-result", relayTxHash: hash }));
          relayReceipt = await waitForTransactionReceipt(config, { hash });
        } catch (error) {
          const message = explainError(error);
          return fail(/rejected/i.test(message) ? "wallet-rejected" : "relay-reverted", message);
        }

        if (relayReceipt.status !== "success") {
          return fail("relay-reverted", "The relay transaction reverted on-chain.");
        }

        // --- 5. Read the new invoice id from the event -------------------------
        const invoiceId = extractInvoiceId(relayReceipt);
        setState((prev) => ({ ...prev, phase: "confirmed", invoiceId }));
        return invoiceId;
      } finally {
        if (abortRef.current === controller) abortRef.current = undefined;
      }
    },
    [config],
  );

  return { state, create, reset };
}

/** Finds `InvoiceCreated` in the relay receipt and returns the new invoice id. */
function extractInvoiceId(receipt: TransactionReceipt): bigint | undefined {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "InvoiceCreated") {
        const args = decoded.args as unknown as { invoiceId: bigint };
        return args.invoiceId;
      }
    } catch {
      // Not an escrow event.
    }
  }
  return undefined;
}
