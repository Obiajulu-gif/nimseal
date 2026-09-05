import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { ethers } from "hardhat";
import { addressUrl, networkInfo, txUrl } from "./networks";

/**
 * Deploys the demo settlement token.
 *
 * Sepolia has no canonical USDT, so the demo needs one. This is a MockERC20 with the
 * same shape as mainnet USDT — 6 decimals, "USDT" — so the amount math being rehearsed is the
 * amount math that will run in production.
 *
 *   npm run deploy-token:testnet
 *
 * Mints to the deployer and, if MINT_TO is set, to a comma-separated list of extra addresses so
 * the demo buyer has a balance to pay with.
 *
 * Refuses to run on mainnet: there the settlement token is real USDT, not a mock.
 */

const MINT_AMOUNT = 1_000_000n * 10n ** 6n; // 1,000,000 USDT

async function main() {
  const net = await networkInfo();
  if (net.isMainnet) {
    throw new Error(
      "Refusing to deploy a mock token on Polygon. Production settles in real USDT " +
        "(0xc2132D05D31c914a87C6611C10748AEb04B58e8F).",
    );
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY in contracts/.env.");

  console.log("Network   :", net.name, `(chain ${net.chainId})`);
  console.log("Deployer  :", deployer.address);

  const factory = await ethers.getContractFactory("MockERC20", deployer);
  const token = await factory.deploy("Test USD", "USDT", 6);
  const deployTx = token.deploymentTransaction();
  if (!deployTx) throw new Error("Deployment transaction is missing.");

  console.log("\nDeploy tx :", deployTx.hash, txUrl(deployTx.hash, net));
  await token.waitForDeployment();
  await deployTx.wait(2);

  const tokenAddress = await token.getAddress();
  console.log("Token     :", tokenAddress, addressUrl(tokenAddress, net));

  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  if (symbol !== "USDT" || Number(decimals) !== 6) {
    throw new Error(`Deployed token reports ${symbol}/${decimals}d, expected USDT/6d.`);
  }
  console.log("Metadata  :", `${symbol}, ${decimals} decimals`);

  const recipients = [
    deployer.address,
    ...(process.env.MINT_TO?.split(",").map((a) => a.trim()).filter(Boolean) ?? []),
  ];
  const unique = [...new Set(recipients.map((a) => ethers.getAddress(a)))];

  console.log();
  for (const to of unique) {
    const tx = await token.mint(to, MINT_AMOUNT);
    await tx.wait(1);
    const bal = await token.balanceOf(to);
    console.log("Minted    :", ethers.formatUnits(bal, 6), "USDT to", to);
  }

  // Record it alongside the escrow deployment so the demo can be reconstructed.
  const path = join(__dirname, "..", "deployments", `token-${net.chainId}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        network: net.isMainnet ? "polygon" : "sepolia",
        chainId: Number(net.chainId),
        tokenAddress,
        symbol,
        decimals: Number(decimals),
        deploymentTx: deployTx.hash,
        mintedTo: unique,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log(`\nWrote ${path}`);

  // Write the address straight into contracts/.env so the next command just works.
  const envPath = join(__dirname, "..", ".env");
  if (existsSync(envPath)) {
    const current = readFileSync(envPath, "utf8");
    const updated = current.includes("SETTLEMENT_TOKEN_ADDRESS=")
      ? current.replace(/SETTLEMENT_TOKEN_ADDRESS=.*/g, `SETTLEMENT_TOKEN_ADDRESS=${tokenAddress}`)
      : `${current.trimEnd()}\nSETTLEMENT_TOKEN_ADDRESS=${tokenAddress}\n`;
    writeFileSync(envPath, updated, "utf8");
    console.log("Set SETTLEMENT_TOKEN_ADDRESS in contracts/.env");
  }

  console.log("\nNext: npm run deploy:testnet");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
