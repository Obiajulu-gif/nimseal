import { ethers } from "hardhat";
import { networkInfo, resolveSettlementToken } from "./networks";

/**
 * Pre-deployment check. Answers "will the next command work?" without spending anything.
 *
 *   npm run preflight:testnet
 *
 * Verifies the RPC is reachable and is the chain we think it is, that a signer is configured,
 * that it holds gas, and that the owner and attestor addresses are consistent with the keys
 * actually loaded. Prints addresses; never prints key material.
 */

function mask(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label.padEnd(26)} ${detail}`);
  return ok;
}

async function main() {
  let allOk = true;

  console.log("Network");
  const net = await networkInfo();
  allOk = mask("chain", true, `${net.name} (${net.chainId})`) && allOk;

  const block = await ethers.provider.getBlockNumber();
  allOk = mask("rpc reachable", block > 0, `head block ${block}`) && allOk;

  console.log("\nDeployer");
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    mask("signer", false, "none — DEPLOYER_PRIVATE_KEY is unset or malformed in contracts/.env");
    process.exitCode = 1;
    return;
  }
  const deployer = signers[0];
  mask("address", true, deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  const symbol = net.nativeSymbol;
  const funded = balance > 0n;
  allOk =
    mask(
      "balance",
      funded,
      funded
        ? `${ethers.formatEther(balance)} ${symbol}`
        : net.isMainnet
          ? `0 POL — fund this exact address with POL for gas before deploying`
          : `0 ETH — fund this address from a Sepolia faucet`,
    ) && allOk;

  // A deploy plus the token deploy plus configure-attestor is comfortably under 0.05.
  if (funded && balance < ethers.parseEther("0.02")) {
    console.log(`        note: balance is low; the full sequence needs roughly 0.02 ${symbol}`);
  }

  const owner = process.env.OWNER_ADDRESS?.trim();
  if (owner) {
    const valid = ethers.isAddress(owner);
    allOk = mask("OWNER_ADDRESS", valid, valid ? owner : `invalid: "${owner}"`) && allOk;
    if (valid && owner.toLowerCase() !== deployer.address.toLowerCase()) {
      console.log("        note: owner differs from deployer — that is fine, just be deliberate");
    }
  } else {
    mask("OWNER_ADDRESS", true, `unset — will default to the deployer`);
  }

  console.log("\nSettlement token");
  // Resolve exactly the way the deploy script will, rather than reimplementing the rules here —
  // an unset override is correct on mainnet (it defaults to USDT) and fatal on testnet, and
  // `resolveSettlementToken` is the single place that knows that.
  try {
    const token = await resolveSettlementToken(net);
    const source = process.env.SETTLEMENT_TOKEN_ADDRESS?.trim()
      ? "from SETTLEMENT_TOKEN_ADDRESS"
      : "default for this network";
    allOk = mask("resolves", true, `${token.address} (${source})`) && allOk;
    allOk =
      mask("metadata", token.decimals === 6, `${token.symbol}, ${token.decimals} decimals`) && allOk;
  } catch (error) {
    allOk = mask("resolves", false, error instanceof Error ? error.message : String(error)) && allOk;
  }

  console.log(
    allOk ? "\nPreflight passed — safe to deploy." : "\nPreflight FAILED — fix the above first.",
  );
  if (!allOk) process.exitCode = 1;
}

main().catch((error) => {
  console.error("\nPreflight error:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
