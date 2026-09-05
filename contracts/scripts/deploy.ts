import { writeFileSync } from "fs";
import { join } from "path";
import { ethers } from "hardhat";
import { addressUrl, networkInfo, resolveSettlementToken, txUrl } from "./networks";

const DEFAULT_REFUND_GRACE_PERIOD_SECONDS = 604_800n;
const CONFIRMATIONS = 2;

function envBigint(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}".`);
  }
  return BigInt(raw);
}

async function main() {
  const net = await networkInfo();
  const token = await resolveSettlementToken(net);

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      "No signer configured. Set DEPLOYER_PRIVATE_KEY in contracts/.env before deploying.",
    );
  }
  const deployer = signers[0];

  const owner = process.env.OWNER_ADDRESS?.trim() || deployer.address;
  if (!ethers.isAddress(owner)) {
    throw new Error(`OWNER_ADDRESS is not a valid address: "${owner}"`);
  }

  const refundGracePeriod = envBigint(
    "REFUND_GRACE_PERIOD_SECONDS",
    DEFAULT_REFUND_GRACE_PERIOD_SECONDS,
  );

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Network             :", net.name, `(chain ${net.chainId})`);
  console.log("Deployer            :", deployer.address);
  console.log("Deployer balance    :", ethers.formatEther(balance), net.nativeSymbol);
  if (balance === 0n) {
    throw new Error(
      net.isMainnet
        ? "Deployer has no POL. Fund the deployer with POL for gas before deploying to Polygon."
        : "Deployer has no Sepolia ETH. Fund it from a Sepolia faucet before deploying.",
    );
  }

  console.log("Owner               :", owner);
  console.log(
    "Settlement token    :",
    token.address,
    `(${token.symbol}, ${token.decimals}d, "${token.name}")`,
  );
  console.log("Refund grace (s)    :", refundGracePeriod.toString());

  const factory = await ethers.getContractFactory("BotSealEscrow", deployer);
  const escrow = await factory.deploy(owner, token.address, refundGracePeriod);

  const deploymentTx = escrow.deploymentTransaction();
  if (!deploymentTx) throw new Error("Deployment transaction is missing.");
  console.log("\nDeployment tx       :", deploymentTx.hash, txUrl(deploymentTx.hash, net));

  await escrow.waitForDeployment();
  await deploymentTx.wait(CONFIRMATIONS);

  const escrowAddress = await escrow.getAddress();
  console.log("Escrow deployed     :", escrowAddress, addressUrl(escrowAddress, net));

  // Read the immutable configuration back from chain and assert it matches what we asked for.
  const [onChainOwner, onChainToken, onChainGrace, onChainScale] = await Promise.all([
    escrow.owner(),
    escrow.SETTLEMENT_TOKEN(),
    escrow.refundGracePeriod(),
    escrow.tokenScale(),
  ]);

  const mismatches: string[] = [];
  if (onChainOwner.toLowerCase() !== owner.toLowerCase()) mismatches.push("owner");
  if (onChainToken.toLowerCase() !== token.address.toLowerCase()) mismatches.push("SETTLEMENT_TOKEN");
  if (onChainGrace !== refundGracePeriod) mismatches.push("refundGracePeriod");
  if (onChainScale !== 10n ** BigInt(token.decimals)) mismatches.push("tokenScale");

  if (mismatches.length > 0) {
    throw new Error(`Post-deployment verification failed for: ${mismatches.join(", ")}`);
  }
  console.log("Post-deploy verification: all immutables match");

  const record = {
    network: net.isMainnet ? "polygon" : "sepolia",
    chainId: Number(net.chainId),
    escrowAddress,
    settlementToken: {
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
    },
    deploymentTx: deploymentTx.hash,
    deployer: deployer.address,
    owner,
    refundGracePeriodSeconds: Number(refundGracePeriod),
    deployedAt: new Date().toISOString(),
  };

  const fileName = `${record.network}-${net.chainId}.json`;
  const outPath = join(__dirname, "..", "deployments", fileName);
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${outPath}`);
  console.log(
    `\nNext: deploy the attestor, then run \`npm run configure-attestor:${record.network}\` with ` +
      "ATTESTOR_SIGNING_ADDRESS set to the address from the attestor's /info endpoint.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
