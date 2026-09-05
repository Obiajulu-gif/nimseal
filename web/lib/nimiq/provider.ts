/**
 * Thin wrapper over `@nimiq/mini-app-sdk` for the Nimiq-native provider.
 *
 * The provider exists only inside the Nimiq Pay WebView. `init()` waits for the host to inject
 * `window.nimiq` and rejects on timeout, which is how we detect the app being opened in a plain
 * browser. The provider's methods resolve to either a result or an `{ error }` object rather than
 * throwing, so every call is unwrapped here into a value-or-throw shape the hooks can use plainly.
 */

import { init as sdkInit, getHostLanguage } from "@nimiq/mini-app-sdk";
import type { NimiqProvider, SignatureResult } from "@nimiq/mini-app-sdk";

import type { SealProof } from "./seal";

export class NimiqUnavailableError extends Error {
  constructor(message = "Nimiq Pay wallet is not available here.") {
    super(message);
    this.name = "NimiqUnavailableError";
  }
}

export class NimiqRejectedError extends Error {
  constructor(message = "You cancelled the Nimiq Pay request.") {
    super(message);
    this.name = "NimiqRejectedError";
  }
}

function isErrorResponse(value: unknown): value is { error: { type: string; message: string } } {
  return typeof value === "object" && value !== null && "error" in value;
}

/** True when the app is running inside Nimiq Pay (the Nimiq provider is injected). */
export function isInsideNimiqPay(): boolean {
  return typeof window !== "undefined" && typeof window.nimiq !== "undefined";
}

/**
 * Resolves the Nimiq provider, or throws {@link NimiqUnavailableError} when the app is not running
 * inside Nimiq Pay. `timeout` bounds the wait for injection so the UI never hangs.
 */
export async function getNimiqProvider(timeout = 4_000): Promise<NimiqProvider> {
  if (typeof window === "undefined") throw new NimiqUnavailableError();
  try {
    return await sdkInit({ timeout });
  } catch {
    throw new NimiqUnavailableError(
      "Open BotSeal inside Nimiq Pay to use your Nimiq wallet.",
    );
  }
}

/** Lists the user's Nimiq addresses. Requires user confirmation in Nimiq Pay. */
export async function listNimiqAccounts(provider: NimiqProvider): Promise<string[]> {
  const result = await provider.listAccounts();
  if (isErrorResponse(result)) throw mapNimiqError(result.error);
  return result;
}

/** Signs a plain-text message with the user's Nimiq key. Returns the public key and signature. */
export async function signNimiqMessage(
  provider: NimiqProvider,
  message: string,
): Promise<SealProof> {
  const result = await provider.sign(message);
  if (isErrorResponse(result)) throw mapNimiqError(result.error);
  const { publicKey, signature } = result as SignatureResult;
  return { publicKey, signature };
}

/** Maps a Nimiq `ErrorResponse` into a typed error with user-facing copy. */
function mapNimiqError(error: { type: string; message: string }): Error {
  const text = `${error.type ?? ""} ${error.message ?? ""}`.toLowerCase();
  if (/reject|denied|cancel|abort/.test(text)) {
    return new NimiqRejectedError();
  }
  return new Error(error.message || "The Nimiq Pay request failed.");
}

/** ISO 639-1 language selected in Nimiq Pay, or a browser/`en` fallback. */
export function hostLanguage(): string {
  if (typeof window === "undefined") return "en";
  return (
    getHostLanguage() ??
    (typeof navigator !== "undefined" ? navigator.language.split("-")[0] : undefined) ??
    "en"
  );
}
