import { readFileSync } from "fs";
import { join } from "path";
import { ethers } from "hardhat";
import { networkInfo, txUrl } from "./networks";

/**
 * Points the deployed escrow at the attestor signing address.
 *
 * The address comes from `ATTESTOR_SIGNING_ADDRESS`, or is discovered from the attestor service's
 * `/info` endpoint when `ATTESTOR_URL` is set. It must be the attestor's *signing* address — never
 * the deployer or the owner.
 */

type InfoResponse = {
  attestorAddress?: string;
  publicKey?: string;
};

/**
 * Reads the signing address from the attestor's `/info`.
 *
 * The service reports the address directly and also the uncompressed public key the browser
 * encrypts to. When both are present they are cross-checked, because an `/info` that advertises
 * one key for encryption and a different address for verification would silently produce invoices
 * the escrow can never accept.
 */
export function attestorAddressFromInfo(info: InfoResponse): string {
  const { attestorAddress, publicKey } = info;

  if (typeof attestorAddress !== "string" || !ethers.isAddress(attestorAddress)) {
    throw new Error(
      "Attestor /info did not contain a valid `attestorAddress`. " +
        "Set ATTESTOR_SIGNING_ADDRESS explicitly instead.",
    );
  }

  if (typeof publicKey === "string" && publicKey.length > 0) {
    const derived = ethers.computeAddress(publicKey);
    if (derived.toLowerCase() !== attestorAddress.toLowerCase()) {
      throw new Error(
        `Attestor /info is inconsistent: publicKey derives to ${derived} but the service ` +
          `reports ${attestorAddress}. Refusing to configure a mismatched signer.`,
      );
    }
  }

  return ethers.getAddress(attestorAddress);
}

async function discoverFromService(baseUrl: string): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, "")}/info`;
  console.log("Querying attestor    :", url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Attestor /info returned HTTP ${response.status}`);
    }
    const info = (await response.json()) as InfoResponse;
    const address = attestorAddressFromInfo(info);
    console.log("Attestor address     :", address);
    return address;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const net = await networkInfo();

  const deploymentPath = join(__dirname, "..", "deployments", `${net.isMainnet ? "polygon" : "sepolia"}-${net.chainId}.json`);
  let escrowAddress: string;
  try {
    escrowAddress = JSON.parse(readFileSync(deploymentPath, "utf8")).escrowAddress;
  } catch {
    throw new Error(`Could not read ${deploymentPath}. Deploy the escrow first.`);
  }

  let attestorAddress = process.env.ATTESTOR_SIGNING_ADDRESS?.trim();
  if (!attestorAddress) {
    const serviceUrl = process.env.ATTESTOR_URL?.trim();
    if (!serviceUrl) {
      throw new Error(
        "Set ATTESTOR_SIGNING_ADDRESS to the address reported by the attestor /info endpoint, " +
          "or set ATTESTOR_URL so this script can read it.",
      );
    }
    attestorAddress = await discoverFromService(serviceUrl);
  }

  if (!ethers.isAddress(attestorAddress)) {
    throw new Error(`"${attestorAddress}" is not a valid address.`);
  }

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("No signer configured. Set DEPLOYER_PRIVATE_KEY in contracts/.env.");
  }
  const sender = signers[0];

  const escrow = await ethers.getContractAt("BotSealEscrow", escrowAddress, sender);

  const owner = await escrow.owner();
  if (owner.toLowerCase() !== sender.address.toLowerCase()) {
    throw new Error(
      `setAttestorAddress is owner-only. Escrow owner is ${owner} but the configured signer is ` +
        `${sender.address}.`,
    );
  }

  const previous = await escrow.attestorAddress();
  console.log("Escrow               :", escrowAddress);
  console.log("Current attestor     :", previous);
  console.log("New attestor         :", attestorAddress);

  if (previous.toLowerCase() === attestorAddress.toLowerCase()) {
    console.log("Already configured. Nothing to do.");
    return;
  }

  const tx = await escrow.setAttestorAddress(attestorAddress);
  console.log("Configuration tx     :", tx.hash, txUrl(tx.hash, net));
  await tx.wait(2);

  const readBack = await escrow.attestorAddress();
  if (readBack.toLowerCase() !== attestorAddress.toLowerCase()) {
    throw new Error(`Read-back mismatch: expected ${attestorAddress}, got ${readBack}`);
  }
  console.log("Read back            :", readBack);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
