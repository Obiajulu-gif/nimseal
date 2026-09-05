import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { ethers } from "hardhat";
import { networkInfo, txUrl } from "./networks";

/**
 * Live end-to-end proof against the DEPLOYED escrow.
 *
 *   npm run smoke-live:testnet
 *
 * The offline rehearsal proves the logic; this proves the deployment. Specifically it proves the
 * EIP-712 domain binds to the real contract address and the real chain id — the one thing that
 * cannot be checked without a deployment, because a signature minted for any other address or
 * chain simply will not verify.
 *
 * Testnet only. It moves real balances and would be reckless to point at mainnet.
 */

const EIP712_TYPES = {
  ConfidentialInvoice: [
    { name: "seller", type: "address" },
    { name: "buyer", type: "address" },
    { name: "usdAmountCents", type: "uint256" },
    { name: "dueAt", type: "uint64" },
    { name: "termsCommitment", type: "bytes32" },
    { name: "attestationId", type: "bytes32" },
  ],
};

const checks: boolean[] = [];
function check(label: string, ok: boolean, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

function readEnvValue(path: string, key: string): string {
  if (!existsSync(path)) throw new Error(`${path} not found`);
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const [k, ...rest] = s.split("=");
    if (k.trim() === key) return rest.join("=").trim();
  }
  throw new Error(`${key} not found in ${path}`);
}

async function main() {
  const net = await networkInfo();
  if (net.isMainnet) throw new Error("smoke-live is testnet-only. Refusing to run on mainnet.");

  const deployments = join(__dirname, "..", "deployments", `${net.isMainnet ? "polygon" : "sepolia"}-${net.chainId}.json`);
  const record = JSON.parse(readFileSync(deployments, "utf8"));
  const escrowAddress: string = record.escrowAddress;
  const tokenAddress: string = record.settlementToken.address;

  const [seller] = await ethers.getSigners();

  // The buyer must not be the seller — the escrow rejects that with SameSellerAndBuyer. For this
  // smoke test the attestor's own key doubles as the buyer: it is a testnet burner we already
  // hold. In the real demo the buyer is a separate wallet in the browser.
  const attestorKey = readEnvValue(join(__dirname, "..", "..", "web", ".env.local"), "ATTESTOR_PRIVATE_KEY");
  const attestor = new ethers.Wallet(attestorKey, ethers.provider);
  const buyer = attestor;

  console.log(`${net.name} (chain ${net.chainId})`);
  console.log("escrow :", escrowAddress);
  console.log("token  :", tokenAddress);
  console.log("seller :", seller.address);
  console.log("buyer  :", buyer.address);
  console.log();

  const escrow = await ethers.getContractAt("NimSealEscrow", escrowAddress, seller);
  const token = await ethers.getContractAt("MockERC20", tokenAddress, seller);

  console.log("Preconditions");
  const onChainAttestor = await escrow.attestorAddress();
  check("attestor configured on chain", onChainAttestor.toLowerCase() === attestor.address.toLowerCase(), onChainAttestor);

  // Make sure the buyer can pay for gas and has tokens.
  let buyerGas = await ethers.provider.getBalance(buyer.address);
  if (buyerGas < ethers.parseEther("0.05")) {
    const top = await seller.sendTransaction({ to: buyer.address, value: ethers.parseEther("0.2") });
    await top.wait(1);
    buyerGas = await ethers.provider.getBalance(buyer.address);
    console.log("        topped up buyer gas");
  }
  check("buyer has gas", buyerGas > 0n, `${ethers.formatEther(buyerGas)} ${net.nativeSymbol}`);

  const needed = 251_022n * 10_000n; // $2,510.22 at 6 decimals
  if ((await token.balanceOf(buyer.address)) < needed) {
    await (await token.mint(buyer.address, 1_000_000n * 10n ** 6n)).wait(1);
    console.log("        minted USDT to buyer");
  }
  check("buyer has USDT", (await token.balanceOf(buyer.address)) >= needed);

  // --- Confidential relay ---------------------------------------------------------
  console.log("\nConfidential relay");
  const dueAt = (await ethers.provider.getBlock("latest"))!.timestamp + 30 * 24 * 3600;
  const commitment = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify({ demo: "smoke-live", at: Date.now() })),
  );
  const attestation = {
    seller: seller.address,
    buyer: buyer.address,
    usdAmountCents: 251_022n,
    dueAt: BigInt(dueAt),
    termsCommitment: commitment,
    attestationId: ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "address", "uint256"],
        [commitment, seller.address, BigInt(Date.now())]),
    ),
  };

  const signature = await attestor.signTypedData(
    { name: "nimSeal", version: "1", chainId: net.chainId, verifyingContract: escrowAddress },
    EIP712_TYPES,
    attestation,
  );

  // The deployed contract's own digest must recover the attestor. This is the check that a
  // local rehearsal structurally cannot make.
  const digest = await escrow.hashConfidentialInvoice(attestation);
  check("deployed digest recovers attestor",
    ethers.recoverAddress(digest, signature).toLowerCase() === attestor.address.toLowerCase());

  const relayTx = await escrow.relayConfidentialInvoice(attestation, signature);
  const relayRc = await relayTx.wait(1);
  check("relay mined", relayRc!.status === 1, txUrl(relayTx.hash, net));

  const invoiceId = await escrow.nextInvoiceId() - 1n;
  const invoice = await escrow.getInvoice(invoiceId);
  check("invoice is confidential", invoice.confidential === true, `id ${invoiceId}`);
  check("total exact", invoice.usdAmountCents === 251_022n, "$2,510.22");

  const relayData = (await ethers.provider.getTransaction(relayTx.hash))!.data;
  check("relay calldata carries no plaintext",
    !relayData.toLowerCase().includes(Buffer.from("smoke-live", "utf8").toString("hex")),
    `${(relayData.length - 2) / 2} bytes`);

  // --- Settle -----------------------------------------------------------------------
  console.log("\nSettlement");
  const required = await escrow.quoteInvoice(invoiceId);
  check("quote exact", required === 251_022n * 10_000n, `${ethers.formatUnits(required, 6)} USDT`);

  await (await token.connect(buyer).approve(escrowAddress, required)).wait(1);
  const fundTx = await escrow.connect(buyer).fundInvoice(invoiceId);
  await fundTx.wait(1);
  check("funded", (await escrow.getInvoice(invoiceId)).status === 2n, txUrl(fundTx.hash, net));

  const sellerBefore = await token.balanceOf(seller.address);
  const releaseTx = await escrow.connect(buyer).releasePayment(invoiceId);
  await releaseTx.wait(1);
  check("released", (await escrow.getInvoice(invoiceId)).status === 3n, txUrl(releaseTx.hash, net));
  check("seller paid exactly",
    (await token.balanceOf(seller.address)) - sellerBefore === required,
    `${ethers.formatUnits(required, 6)} USDT`);
  check("escrow accounting zeroed", (await escrow.totalEscrowed()) === 0n);

  const failed = checks.filter((c) => !c).length;
  console.log(failed === 0
    ? `\nALL ${checks.length} LIVE CHECKS PASSED on chain ${net.chainId}`
    : `\n${failed} of ${checks.length} FAILED`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("\nLIVE SMOKE FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
