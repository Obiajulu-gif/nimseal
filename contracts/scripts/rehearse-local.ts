import { ethers } from "hardhat";

/**
 * Full rehearsal of the demo flow: deploy, relay an attestor-signed invoice, fund, release.
 *
 * Runs in-process against hardhat's own network, so it needs no gas, no key and no testnet. Its
 * job is to prove the whole sequence works before anyone spends BOT on a real deployment.
 *
 *   npx hardhat run scripts/rehearse-local.ts
 *
 * If the frontend is running, the script drives the REAL attestor service over HTTP — encrypt,
 * decrypt, revalidate, sign — which is the one seam neither test suite covers on its own:
 *
 *   cd web && npm run dev            # .env.local needs ATTESTOR_PRIVATE_KEY
 *   ATTESTOR_BASE_URL=http://127.0.0.1:3000 npx hardhat run scripts/rehearse-local.ts
 *
 * With no service reachable it signs locally using the same EIP-712 domain and type, and says so.
 * The contract half is proven either way; only the service round-trip is skipped.
 */

const ATTESTOR_URL = process.env.ATTESTOR_BASE_URL?.replace(/\/+$/, "");
const REFUND_GRACE_PERIOD = 604_800n;
const SCALE = 10n ** 6n;

/** 2*125000 + 3*1999 - 10000 + 5025 = 251022 cents = $2,510.22 */
const EXPECTED_CENTS = 251_022n;

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

const checks: Array<{ ok: boolean; label: string }> = [];
function check(label: string, ok: boolean, detail = "") {
  checks.push({ ok, label });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

interface Attestation {
  seller: string;
  buyer: string;
  usdAmountCents: bigint;
  dueAt: bigint;
  termsCommitment: string;
  attestationId: string;
}

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  const [deployer, attestorWallet, seller, buyer, tokenDeployer] = await ethers.getSigners();

  console.log(`chain ${chainId}\n`);

  // --- Deploy ------------------------------------------------------------------
  console.log("Deploy");
  const TokenFactory = await ethers.getContractFactory("MockERC20", tokenDeployer);
  const token = await TokenFactory.deploy("Test USD", "USDT", 6);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  const EscrowFactory = await ethers.getContractFactory("NimSealEscrow", deployer);
  const escrow = await EscrowFactory.deploy(deployer.address, tokenAddress, REFUND_GRACE_PERIOD);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();

  check("escrow deployed", (await ethers.provider.getCode(escrowAddress)) !== "0x", escrowAddress);
  check("settles in a 6-decimal token", (await escrow.tokenScale()) === SCALE);

  await (await token.connect(tokenDeployer).mint(buyer.address, 1_000_000n * SCALE)).wait();

  // --- Obtain an attestation ----------------------------------------------------
  const dueAt = (await ethers.provider.getBlock("latest"))!.timestamp + 30 * 24 * 3600;
  const payload = {
    version: 1,
    seller: seller.address,
    buyer: buyer.address,
    escrowContract: escrowAddress,
    invoiceReference: "INV-2026-014",
    dueAt,
    currency: "USD",
    items: [
      { description: "Design retainer, March", quantity: "2", unitPriceCents: "125000" },
      { description: "Hosting, Q1", quantity: "3", unitPriceCents: "1999" },
    ],
    discountCents: "10000",
    taxCents: "5025",
    nonce: ethers.hexlify(ethers.randomBytes(32)),
    salt: ethers.hexlify(ethers.randomBytes(32)),
  };

  let attestation: Attestation;
  let signature: string;
  let attestorAddress: string;
  let liveService = false;

  const info = ATTESTOR_URL ? await tryFetchInfo(ATTESTOR_URL) : undefined;

  if (info && BigInt(info.chainId) === chainId) {
    console.log("\nAttestor  (live service)");
    liveService = true;
    attestorAddress = info.attestorAddress;

    const { encrypt } = await import("ecies-geth");
    const cipher = await encrypt(
      Buffer.from(info.publicKey.slice(2), "hex"),
      Buffer.from(JSON.stringify(payload), "utf-8"),
    );
    const res = await fetch(`${ATTESTOR_URL}/api/attestor/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ciphertext: `0x${Buffer.from(cipher).toString("hex")}` }),
    });
    const body = (await res.json()) as
      | { ok: true; attestation: Record<string, string>; signature: string }
      | { ok: false; error: string; message: string };
    if (!body.ok) throw new Error(`attestor refused: ${body.error} — ${body.message}`);

    attestation = {
      seller: body.attestation.seller,
      buyer: body.attestation.buyer,
      usdAmountCents: BigInt(body.attestation.usdAmountCents),
      dueAt: BigInt(body.attestation.dueAt),
      termsCommitment: body.attestation.termsCommitment,
      attestationId: body.attestation.attestationId,
    };
    signature = body.signature;
    check("service recomputed the total from line items", attestation.usdAmountCents === EXPECTED_CENTS,
      `${attestation.usdAmountCents} cents`);
  } else {
    console.log(
      ATTESTOR_URL
        ? "\nAttestor  (local signing — service unreachable or on another chain)"
        : "\nAttestor  (local signing — set ATTESTOR_BASE_URL to drive the real service)",
    );
    attestorAddress = attestorWallet.address;
    const commitment = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)));
    attestation = {
      seller: seller.address,
      buyer: buyer.address,
      usdAmountCents: EXPECTED_CENTS,
      dueAt: BigInt(dueAt),
      termsCommitment: commitment,
      attestationId: ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "address"],
          [commitment, seller.address],
        ),
      ),
    };
    signature = await attestorWallet.signTypedData(
      { name: "nimSeal", version: "1", chainId, verifyingContract: escrowAddress },
      EIP712_TYPES,
      attestation,
    );
  }

  await (await escrow.setAttestorAddress(attestorAddress)).wait();

  // The contract's own digest must recover the signer. This is the seam between the two halves.
  const digest = await escrow.hashConfidentialInvoice(attestation);
  check(
    "contract digest recovers the attestor",
    ethers.recoverAddress(digest, signature).toLowerCase() === attestorAddress.toLowerCase(),
  );

  // --- Relay ---------------------------------------------------------------------
  console.log("\nRelay");
  const relay = await escrow.connect(seller).relayConfidentialInvoice(attestation, signature);
  const receipt = await relay.wait();
  check("relay accepted", receipt!.status === 1, `gas ${receipt!.gasUsed}`);

  const invoice = await escrow.getInvoice(1n);
  check("marked confidential", invoice.confidential === true);
  check("total stored exactly", invoice.usdAmountCents === EXPECTED_CENTS, "$2,510.22");

  const calldata = (await ethers.provider.getTransaction(relay.hash))!.data.toLowerCase();
  const leaked = ["Design retainer", "Hosting, Q1", "INV-2026-014"].filter((s) =>
    calldata.includes(Buffer.from(s, "utf8").toString("hex").toLowerCase()),
  );
  check("no plaintext in calldata", leaked.length === 0, `${(calldata.length - 2) / 2} bytes`);

  let replayRejected = false;
  try {
    await escrow.connect(seller).relayConfidentialInvoice(attestation, signature);
  } catch {
    replayRejected = true;
  }
  check("replay rejected", replayRejected);

  // --- Settle ---------------------------------------------------------------------
  console.log("\nSettle");
  const required = await escrow.quoteInvoice(1n);
  check("quote exact", required === EXPECTED_CENTS * 10_000n, `${ethers.formatUnits(required, 6)} USDT`);

  await (await token.connect(buyer).approve(escrowAddress, required)).wait();
  await (await escrow.connect(buyer).fundInvoice(1n)).wait();
  check("escrow holds the funds", (await token.balanceOf(escrowAddress)) === required);

  const before = await token.balanceOf(seller.address);
  await (await escrow.connect(buyer).releasePayment(1n)).wait();
  check("seller paid exactly", (await token.balanceOf(seller.address)) - before === required);
  check("escrow drained", (await token.balanceOf(escrowAddress)) === 0n);
  check("status Released", (await escrow.getInvoice(1n)).status === 3n);
  check("accounting zeroed", (await escrow.totalEscrowed()) === 0n);

  const failed = checks.filter((c) => !c.ok).length;
  console.log(
    failed === 0
      ? `\nALL ${checks.length} CHECKS PASSED` +
          (liveService
            ? " — including the live attestor round-trip."
            : " — contract half proven; attestor signed locally.")
      : `\n${failed} of ${checks.length} FAILED.`,
  );
  if (failed > 0) process.exitCode = 1;
}

async function tryFetchInfo(base: string) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(`${base}/api/attestor/info`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return undefined;
    return (await res.json()) as {
      publicKey: string;
      attestorAddress: string;
      chainId: number;
      escrowContract: string;
    };
  } catch {
    return undefined;
  }
}

main().catch((error) => {
  console.error("\nREHEARSAL FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
