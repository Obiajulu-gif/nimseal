import { readFileSync } from "fs";
import { join } from "path";
import { ethers } from "hardhat";
import { addressUrl, networkInfo, type NetworkInfo } from "./botchain";

/**
 * Read-only checks against a deployed escrow. No key, no writes, no gas.
 *
 * Run this immediately after deploying and again before the demo: it is the cheapest way to catch
 * a wrong settlement token, an unconfigured attestor, or an escrow whose on-chain scale does not
 * match the token it was deployed against.
 */

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

type Check = { label: string; ok: boolean; detail: string };

const checks: Check[] = [];
function record(label: string, ok: boolean, detail: string) {
  checks.push({ label, ok, detail });
}

function readDeployment(net: NetworkInfo): { escrowAddress: string } {
  const path = join(__dirname, "..", "deployments", `botchain-${net.chainId}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Could not read ${path}. Deploy the escrow first.`);
  }
}

async function main() {
  const net = await networkInfo();
  console.log(`Network : ${net.name} (chain ${net.chainId})`);

  const blockNumber = await ethers.provider.getBlockNumber();
  record("RPC reachable", blockNumber > 0, `head block ${blockNumber}`);

  const escrowAddress =
    process.env.ESCROW_ADDRESS?.trim() || readDeployment(net).escrowAddress;
  console.log(`Escrow  : ${escrowAddress} ${addressUrl(escrowAddress, net)}\n`);

  const code = await ethers.provider.getCode(escrowAddress);
  record("Escrow has bytecode", code !== "0x", `${(code.length - 2) / 2} bytes`);
  if (code === "0x") {
    report();
    return;
  }

  const escrow = await ethers.getContractAt("BotSealEscrow", escrowAddress);

  const [tokenAddress, tokenScale, grace, attestor, nextId, escrowed, owner] = await Promise.all([
    escrow.SETTLEMENT_TOKEN(),
    escrow.tokenScale(),
    escrow.refundGracePeriod(),
    escrow.attestorAddress(),
    escrow.nextInvoiceId(),
    escrow.totalEscrowed(),
    escrow.owner(),
  ]);

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, ethers.provider);
  const [symbol, decimals, heldBalance] = await Promise.all([
    token.symbol() as Promise<string>,
    token.decimals() as Promise<bigint>,
    token.balanceOf(escrowAddress) as Promise<bigint>,
  ]);

  record("Settlement token reachable", true, `${tokenAddress} (${symbol}, ${decimals}d)`);

  // The single most damaging silent misconfiguration: an escrow whose cached scale does not match
  // the token it points at would mis-size every invoice by orders of magnitude.
  record(
    "tokenScale matches token decimals",
    tokenScale === 10n ** decimals,
    `scale ${tokenScale}, decimals ${decimals}`,
  );

  if (net.isMainnet) {
    record(
      "Mainnet settles in USDT",
      symbol === "USDT" && decimals === 6n,
      `${symbol}/${decimals}d`,
    );
  }

  record("Owner set", owner !== ethers.ZeroAddress, owner);

  const attestorConfigured = attestor !== ethers.ZeroAddress;
  record(
    "Attestor configured",
    attestorConfigured,
    attestorConfigured
      ? attestor
      : "not set — relayConfidentialInvoice reverts with AttestorNotConfigured",
  );

  // Escrowed accounting must never exceed what the contract actually holds.
  record(
    "Escrowed accounting is backed by real balance",
    heldBalance >= escrowed,
    `held ${heldBalance}, accounted ${escrowed}`,
  );

  console.log(`Invoices created     : ${nextId - 1n}`);
  console.log(`Currently escrowed   : ${ethers.formatUnits(escrowed, decimals)} ${symbol}`);
  console.log(`Refund grace period  : ${grace}s\n`);

  report();
}

function report() {
  let failed = 0;
  for (const { label, ok, detail } of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(42)} ${detail}`);
  }
  console.log("");
  if (failed > 0) {
    console.error(`${failed} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`All ${checks.length} checks passed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
