"use client";

/**
 * Nimiq-native wallet state and the invoice-sealing action.
 *
 * Connection lifecycle:
 *   initializing → available (inside Nimiq Pay, not yet authorised)
 *               → connected (account listed)
 *               → unavailable (opened outside Nimiq Pay)
 *               → error
 *
 * Account access and signing both require user confirmation in Nimiq Pay, so they are only ever
 * triggered by an explicit user gesture — never on mount. On mount we only probe for the provider,
 * which needs no confirmation.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  getNimiqProvider,
  isInsideNimiqPay,
  listNimiqAccounts,
  signNimiqMessage,
  NimiqRejectedError,
  NimiqUnavailableError,
} from "@/lib/nimiq/provider";
import {
  buildSealMessage,
  publicKeyHexToAddress,
  type SealProof,
  type SealSubject,
} from "@/lib/nimiq/seal";

export type NimiqStatus =
  | "initializing"
  | "available"
  | "requesting-permission"
  | "connected"
  | "unavailable"
  | "error";

export interface NimiqState {
  status: NimiqStatus;
  address?: string;
  error?: string;
}

export interface SealResult {
  proof: SealProof;
  /** The signer's Nimiq address, derived from the returned public key. */
  address: string;
}

export function useNimiq() {
  const [state, setState] = useState<NimiqState>({ status: "initializing" });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // Probe only. No confirmation dialog is triggered here.
    if (isInsideNimiqPay()) {
      setState({ status: "available" });
    } else {
      // Give the host a brief window to inject the provider before declaring it absent.
      getNimiqProvider(3_000)
        .then(() => mounted.current && setState({ status: "available" }))
        .catch(() => mounted.current && setState({ status: "unavailable" }));
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Requests the user's Nimiq address. Triggers a confirmation dialog in Nimiq Pay. */
  const connect = useCallback(async (): Promise<string | undefined> => {
    setState((prev) => ({ ...prev, status: "requesting-permission", error: undefined }));
    try {
      const provider = await getNimiqProvider();
      const accounts = await listNimiqAccounts(provider);
      const address = accounts[0];
      if (!address) {
        setState({ status: "available", error: "No Nimiq account was returned." });
        return undefined;
      }
      setState({ status: "connected", address });
      return address;
    } catch (error) {
      return handle(error);
    }
  }, []);

  /**
   * Signs the canonical seal message for {subject} with the user's Nimiq key and returns the proof
   * plus the derived signer address. Triggers a confirmation dialog in Nimiq Pay.
   */
  const seal = useCallback(async (subject: SealSubject): Promise<SealResult | undefined> => {
    setState((prev) => ({ ...prev, status: "requesting-permission", error: undefined }));
    try {
      const provider = await getNimiqProvider();
      const message = buildSealMessage(subject);
      const proof = await signNimiqMessage(provider, message);
      const address = publicKeyHexToAddress(proof.publicKey);
      setState({ status: "connected", address });
      return { proof, address };
    } catch (error) {
      handle(error);
      return undefined;
    }
  }, []);

  function handle(error: unknown): undefined {
    if (!mounted.current) return undefined;
    if (error instanceof NimiqUnavailableError) {
      setState({ status: "unavailable", error: error.message });
    } else if (error instanceof NimiqRejectedError) {
      setState((prev) => ({ status: prev.address ? "connected" : "available", address: prev.address, error: error.message }));
    } else {
      setState((prev) => ({
        status: "error",
        address: prev.address,
        error: error instanceof Error ? error.message : "The Nimiq Pay request failed.",
      }));
    }
    return undefined;
  }

  const reset = useCallback(() => {
    setState((prev) => ({ status: prev.status === "unavailable" ? "unavailable" : "available" }));
  }, []);

  return { state, connect, seal, reset };
}
