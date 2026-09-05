import { ethers } from "hardhat";
import { keccak256, toUtf8Bytes } from "ethers";

/**
 * Creates a public-fallback invoice on the deployed escrow so the hosted app has real, linkable
 * on-chain state for reviewers.
 *
 * This uses `createPublicInvoice`, NOT the confidential path. The commitment is computed locally
 * from fresh entropy, so it is hiding — but no attestor validated it, and the invoice is marked
 * `confidential = false` on-chain. The UI labels it "Public fallback" everywhere. Nothing here
 * simulates or stands in for an attestor-signed invoice.
 *
 * Usage:
 *   BUYER_ADDRESS=0x... npx hardhat run scripts/seed-demo-invoice.ts --network polygon
 *
 * Optional:
 *   AMOUNT_USD=2510.22    invoice total in dollars (default 2510.22)
 *   DUE_IN_DAYS=30        days until due (default 30)
 *   REFERENCE=INV-2026-01 reference mixed into the commitment (never stored on-chain)
 */
async function main() {
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY in contracts/.env.");

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 137n && network.chainId !== 11155111n) {
    throw new Error(
      `Expected Polygon (137) or Sepolia (11155111), got chain ${network.chainId}.`,
    );
  }

  const escrowAddress = process.env.ESCROW_ADDRESS ?? readDeployedEscrow(network.chainId);
  const buyer = process.env.BUYER_ADDRESS?.trim();

  if (!buyer || !ethers.isAddress(buyer)) {
    throw new Error(
      "Set BUYER_ADDRESS to the wallet that should receive this invoice.\n" +
        "  It must differ from the seller — the escrow reverts with SameSellerAndBuyer otherwise.",
    );
  }
  if (buyer.toLowerCase() === signer.address.toLowerCase()) {
    throw new Error("BUYER_ADDRESS must differ from the seller address.");
  }

  // Integer cents only. Parsing the dollar string by hand avoids float drift entirely.
  const amountUsd = process.env.AMOUNT_USD ?? "2510.22";
  if (!/^\d+(\.\d{1,2})?$/.test(amountUsd)) {
    throw new Error(`AMOUNT_USD must look like 2510.22, got "${amountUsd}"`);
  }
  const [whole = "0", fraction = ""] = amountUsd.split(".");
  const usdAmountCents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));

  const dueInDays = Number(process.env.DUE_IN_DAYS ?? "30");
  const latest = await ethers.provider.getBlock("latest");
  if (!latest) throw new Error("Could not read the latest block.");
  const dueAt = BigInt(latest.timestamp + dueInDays * 24 * 60 * 60);

  const reference = process.env.REFERENCE ?? "INV-2026-014";

  // 32 bytes of entropy keeps the commitment hiding even though the terms are simple.
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const termsCommitment = keccak256(
    toUtf8Bytes(`BOTSEAL_PUBLIC_DEMO_V1:${reference}:${usdAmountCents}:${dueAt}:${salt}`),
  );

  const escrow = await ethers.getContractAt("BotSealEscrow", escrowAddress, signer);

  console.log("Escrow          :", escrowAddress);
  console.log("Seller          :", signer.address);
  console.log("Buyer           :", buyer);
  console.log("Amount          :", `$${amountUsd} (${usdAmountCents} cents)`);
  console.log("Due             :", new Date(Number(dueAt) * 1000).toISOString());
  console.log("Commitment      :", termsCommitment);
  console.log("");

  const tx = await escrow.createPublicInvoice(buyer, termsCommitment, usdAmountCents, dueAt);
  console.log("Submitted       :", tx.hash);

  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("createPublicInvoice reverted.");

  // Read the id straight out of the event rather than assuming nextInvoiceId - 1.
  let invoiceId: bigint | undefined;
  for (const log of receipt.logs) {
    try {
      const parsed = escrow.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "InvoiceCreated") {
        invoiceId = parsed.args.invoiceId as bigint;
        break;
      }
    } catch {
      // Not an escrow event.
    }
  }
  if (invoiceId === undefined) throw new Error("No InvoiceCreated event in the receipt.");

  const explorer =
    network.chainId === 137n
      ? process.env.POLYGON_EXPLORER_BASE_URL ?? "https://polygonscan.com"
      : process.env.SEPOLIA_EXPLORER_BASE_URL ?? "https://sepolia.etherscan.io";
  const appUrl = process.env.APP_BASE_URL?.replace(/\/+$/, "") ?? "";

  console.log("");
  console.log("Invoice created :", `#${invoiceId}`);
  console.log("Transaction     :", `${explorer}/tx/${receipt.hash}`);
  if (appUrl) {
    console.log("View in the app :", `${appUrl}/invoices/${invoiceId}`);
    console.log("Buyer pays at   :", `${appUrl}/pay/${invoiceId}`);
  }
  console.log("");
  console.log("Note: this is a PUBLIC fallback invoice (confidential = false). The UI labels it as");
  console.log("such. It is not, and does not stand in for, an attestor-validated invoice.");
}

function readDeployedEscrow(chainId: bigint): string {
  const file = `${chainId === 137n ? "polygon" : "sepolia"}-${chainId}.json`;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const deployment = require(`../deployments/${file}`) as { escrowAddress?: string };
  if (!deployment.escrowAddress) {
    throw new Error(`No escrowAddress in deployments/${file} — set ESCROW_ADDRESS instead.`);
  }
  return deployment.escrowAddress;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
