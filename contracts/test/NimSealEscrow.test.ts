import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { Wallet } from "ethers";
import type { NimSealEscrow, MockERC20 } from "../typechain-types";

const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;

const TOKEN_DECIMALS = 6n;
const TOKEN_SCALE = 10n ** TOKEN_DECIMALS;

const REFUND_GRACE_PERIOD = 7n * 24n * 60n * 60n; // 7 days

/** $100.00 expressed in integer cents. */
const USD_100 = 10_000n;
/** The settlement-token amount $100.00 must convert to: 100 * 10^6. */
const USD_100_IN_TOKENS = 100n * TOKEN_SCALE;

const COMMITMENT = ethers.keccak256(ethers.toUtf8Bytes("terms-commitment-v1"));
const ATTESTATION_ID = ethers.keccak256(ethers.toUtf8Bytes("attestation-1"));

/**
 * The EIP-712 type the escrow verifies. Kept here in full rather than imported, so that a change
 * to the contract's typehash breaks these tests loudly instead of being mirrored automatically.
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

type Attestation = {
  seller: string;
  buyer: string;
  usdAmountCents: bigint;
  dueAt: bigint;
  termsCommitment: string;
  attestationId: string;
};

function domainFor(chainId: bigint, verifyingContract: string) {
  return { name: "nimSeal", version: "1", chainId, verifyingContract };
}

async function signAttestation(
  signer: Wallet | HardhatEthersSigner,
  attestation: Attestation,
  chainId: bigint,
  verifyingContract: string,
): Promise<string> {
  return signer.signTypedData(domainFor(chainId, verifyingContract), EIP712_TYPES, attestation);
}

describe("NimSealEscrow", () => {
  async function deployFixture() {
    const [owner, seller, buyer, stranger] = await ethers.getSigners();

    // Deterministic attestor key so signature tests are reproducible.
    const attestorWallet = new ethers.Wallet(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const rogueWallet = new ethers.Wallet(
      "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    );

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const token = (await MockERC20Factory.deploy(
      "Tether USD",
      "USDT",
      6,
    )) as unknown as MockERC20;
    await token.waitForDeployment();

    const EscrowFactory = await ethers.getContractFactory("NimSealEscrow");
    const escrow = (await EscrowFactory.deploy(
      owner.address,
      await token.getAddress(),
      REFUND_GRACE_PERIOD,
    )) as unknown as NimSealEscrow;
    await escrow.waitForDeployment();

    // Buyer starts with 1,000,000 USDT so balance is never the limiting factor by accident.
    await token.mint(buyer.address, 1_000_000n * TOKEN_SCALE);

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const escrowAddress = await escrow.getAddress();

    /** Due date one hour ahead of the current block by default. */
    async function dueSoon(offsetSeconds = 3600n) {
      return BigInt(await time.latest()) + offsetSeconds;
    }

    return {
      owner,
      seller,
      buyer,
      stranger,
      attestorWallet,
      rogueWallet,
      token,
      escrow,
      escrowAddress,
      chainId,
      dueSoon,
    };
  }

  /** Fixture with the attestor configured and a valid signed attestation ready to relay. */
  async function confidentialFixture() {
    const base = await deployFixture();
    await base.escrow.connect(base.owner).setAttestorAddress(base.attestorWallet.address);

    const dueAt = await base.dueSoon(7n * 24n * 3600n);
    const attestation: Attestation = {
      seller: base.seller.address,
      buyer: base.buyer.address,
      usdAmountCents: USD_100,
      dueAt,
      termsCommitment: COMMITMENT,
      attestationId: ATTESTATION_ID,
    };
    const signature = await signAttestation(
      base.attestorWallet,
      attestation,
      base.chainId,
      base.escrowAddress,
    );

    return { ...base, attestation, signature, dueAt };
  }

  /** Creates a pending public invoice and returns its id. */
  async function createPendingInvoice(ctx: Awaited<ReturnType<typeof deployFixture>>) {
    const dueAt = await ctx.dueSoon(7n * 24n * 3600n);
    await ctx.escrow
      .connect(ctx.seller)
      .createPublicInvoice(ctx.buyer.address, COMMITMENT, USD_100, dueAt);
    return { invoiceId: 1n, dueAt };
  }

  /** Creates and funds an invoice, returning its id and the exact amount escrowed. */
  async function createFundedInvoice(ctx: Awaited<ReturnType<typeof deployFixture>>) {
    const { invoiceId, dueAt } = await createPendingInvoice(ctx);
    const required = await ctx.escrow.quoteInvoice(invoiceId);
    await ctx.token.connect(ctx.buyer).approve(ctx.escrowAddress, required);
    await ctx.escrow.connect(ctx.buyer).fundInvoice(invoiceId);
    return { invoiceId, dueAt, required };
  }

  // -------------------------------------------------------------------
  // Deployment
  // -------------------------------------------------------------------

  describe("Deployment", () => {
    it("stores immutable configuration", async () => {
      const { escrow, owner, token } = await loadFixture(deployFixture);

      expect(await escrow.owner()).to.equal(owner.address);
      expect(await escrow.SETTLEMENT_TOKEN()).to.equal(await token.getAddress());
      expect(await escrow.tokenScale()).to.equal(TOKEN_SCALE);
      expect(await escrow.refundGracePeriod()).to.equal(REFUND_GRACE_PERIOD);
      expect(await escrow.nextInvoiceId()).to.equal(1n);
      expect(await escrow.totalEscrowed()).to.equal(0n);
      expect(await escrow.attestorAddress()).to.equal(ZERO_ADDRESS);
    });

    it("rejects a zero owner", async () => {
      const { token } = await loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("NimSealEscrow");

      await expect(
        factory.deploy(ZERO_ADDRESS, await token.getAddress(), REFUND_GRACE_PERIOD),
      ).to.be.revertedWithCustomError(factory, "OwnableInvalidOwner");
    });

    it("rejects a zero settlement token", async () => {
      const { owner } = await loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("NimSealEscrow");

      await expect(
        factory.deploy(owner.address, ZERO_ADDRESS, REFUND_GRACE_PERIOD),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("rejects an externally owned account where a contract is required", async () => {
      const { owner, stranger } = await loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("NimSealEscrow");

      await expect(
        factory.deploy(owner.address, stranger.address, REFUND_GRACE_PERIOD),
      ).to.be.revertedWithCustomError(factory, "NotAContract");
    });

    it("rejects a token reporting more than 18 decimals", async () => {
      const { owner } = await loadFixture(deployFixture);

      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const oddToken = await MockERC20Factory.deploy("Odd", "ODD", 19);
      await oddToken.waitForDeployment();

      const factory = await ethers.getContractFactory("NimSealEscrow");
      await expect(
        factory.deploy(owner.address, await oddToken.getAddress(), REFUND_GRACE_PERIOD),
      ).to.be.revertedWithCustomError(factory, "UnsupportedTokenDecimals");
    });

    it("exposes an EIP-712 domain bound to this chain and this contract", async () => {
      const { escrow, escrowAddress, chainId } = await loadFixture(deployFixture);

      const domain = await escrow.eip712Domain();
      expect(domain.name).to.equal("nimSeal");
      expect(domain.version).to.equal("1");
      expect(domain.chainId).to.equal(chainId);
      expect(domain.verifyingContract).to.equal(escrowAddress);
    });
  });

  // -------------------------------------------------------------------
  // createPublicInvoice
  // -------------------------------------------------------------------

  describe("createPublicInvoice", () => {
    it("creates a pending public invoice and emits InvoiceCreated", async () => {
      const ctx = await loadFixture(deployFixture);
      const dueAt = await ctx.dueSoon(7n * 24n * 3600n);

      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .createPublicInvoice(ctx.buyer.address, COMMITMENT, USD_100, dueAt),
      )
        .to.emit(ctx.escrow, "InvoiceCreated")
        .withArgs(
          1n,
          ctx.seller.address,
          ctx.buyer.address,
          COMMITMENT,
          USD_100,
          dueAt,
          false,
          ZERO_BYTES32,
        );

      const invoice = await ctx.escrow.getInvoice(1n);
      expect(invoice.seller).to.equal(ctx.seller.address);
      expect(invoice.buyer).to.equal(ctx.buyer.address);
      expect(invoice.usdAmountCents).to.equal(USD_100);
      expect(invoice.tokenAmount).to.equal(0n);
      expect(invoice.confidential).to.equal(false);
      expect(invoice.attestationId).to.equal(ZERO_BYTES32);
      expect(invoice.status).to.equal(1n); // Pending
    });

    it("increments the invoice id and updates both party indexes", async () => {
      const ctx = await loadFixture(deployFixture);
      const dueAt = await ctx.dueSoon(7n * 24n * 3600n);

      await ctx.escrow
        .connect(ctx.seller)
        .createPublicInvoice(ctx.buyer.address, COMMITMENT, USD_100, dueAt);
      await ctx.escrow
        .connect(ctx.seller)
        .createPublicInvoice(ctx.buyer.address, COMMITMENT, USD_100, dueAt);

      expect(await ctx.escrow.nextInvoiceId()).to.equal(3n);
      expect(await ctx.escrow.getSellerInvoiceIds(ctx.seller.address)).to.deep.equal([1n, 2n]);
      expect(await ctx.escrow.getBuyerInvoiceIds(ctx.buyer.address)).to.deep.equal([1n, 2n]);
      expect(await ctx.escrow.invoiceExists(1n)).to.equal(true);
      expect(await ctx.escrow.invoiceExists(99n)).to.equal(false);
    });

    it("rejects a zero buyer", async () => {
      const ctx = await loadFixture(deployFixture);
      const dueAt = await ctx.dueSoon();

      await expect(
        ctx.escrow.connect(ctx.seller).createPublicInvoice(ZERO_ADDRESS, COMMITMENT, USD_100, dueAt),
      ).to.be.revertedWithCustomError(ctx.escrow, "ZeroAddress");
    });

    it("rejects the seller naming themselves as buyer", async () => {
      const ctx = await loadFixture(deployFixture);
      const dueAt = await ctx.dueSoon();

      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .createPublicInvoice(ctx.seller.address, COMMITMENT, USD_100, dueAt),
      ).to.be.revertedWithCustomError(ctx.escrow, "SameSellerAndBuyer");
    });

    it("rejects a zero amount", async () => {
      const ctx = await loadFixture(deployFixture);
      const dueAt = await ctx.dueSoon();

      await expect(
        ctx.escrow.connect(ctx.seller).createPublicInvoice(ctx.buyer.address, COMMITMENT, 0n, dueAt),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidAmount");
    });

    it("rejects a zero commitment", async () => {
      const ctx = await loadFixture(deployFixture);
      const dueAt = await ctx.dueSoon();

      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .createPublicInvoice(ctx.buyer.address, ZERO_BYTES32, USD_100, dueAt),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidCommitment");
    });

    it("rejects a due date in the past", async () => {
      const ctx = await loadFixture(deployFixture);
      const past = BigInt(await time.latest()) - 1n;

      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .createPublicInvoice(ctx.buyer.address, COMMITMENT, USD_100, past),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidDueDate");
    });

    it("reverts reading an invoice that does not exist", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.escrow.getInvoice(42n)).to.be.revertedWithCustomError(
        ctx.escrow,
        "InvoiceNotFound",
      );
    });
  });

  // -------------------------------------------------------------------
  // relayConfidentialInvoice
  // -------------------------------------------------------------------

  describe("relayConfidentialInvoice", () => {
    it("accepts a correctly signed attestation and creates a confidential invoice", async () => {
      const ctx = await loadFixture(confidentialFixture);

      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(ctx.attestation, ctx.signature),
      )
        .to.emit(ctx.escrow, "InvoiceCreated")
        .withArgs(
          1n,
          ctx.seller.address,
          ctx.buyer.address,
          COMMITMENT,
          USD_100,
          ctx.dueAt,
          true,
          ATTESTATION_ID,
        );

      const invoice = await ctx.escrow.getInvoice(1n);
      expect(invoice.confidential).to.equal(true);
      expect(invoice.attestationId).to.equal(ATTESTATION_ID);
      expect(await ctx.escrow.consumedAttestationIds(ATTESTATION_ID)).to.equal(true);
    });

    it("the digest it verifies matches hashConfidentialInvoice", async () => {
      const ctx = await loadFixture(confidentialFixture);

      const onChain = await ctx.escrow.hashConfidentialInvoice(ctx.attestation);
      const offChain = ethers.TypedDataEncoder.hash(
        domainFor(ctx.chainId, ctx.escrowAddress),
        EIP712_TYPES,
        ctx.attestation,
      );

      expect(onChain).to.equal(offChain);
      expect(ethers.recoverAddress(onChain, ctx.signature)).to.equal(ctx.attestorWallet.address);
    });

    it("rejects a signature bound to a different chain id", async () => {
      const ctx = await loadFixture(confidentialFixture);

      const wrongChain = await signAttestation(
        ctx.attestorWallet,
        ctx.attestation,
        ctx.chainId + 1n,
        ctx.escrowAddress,
      );

      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(ctx.attestation, wrongChain),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidAttestorSignature");
    });

    it("rejects a signature bound to a different escrow contract", async () => {
      const ctx = await loadFixture(confidentialFixture);

      const otherEscrow = ethers.Wallet.createRandom().address;
      const wrongVerifier = await signAttestation(
        ctx.attestorWallet,
        ctx.attestation,
        ctx.chainId,
        otherEscrow,
      );

      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(ctx.attestation, wrongVerifier),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidAttestorSignature");
    });

    it("rejects a tampered amount even with an otherwise valid signature", async () => {
      const ctx = await loadFixture(confidentialFixture);

      const tampered = { ...ctx.attestation, usdAmountCents: USD_100 * 2n };

      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(tampered, ctx.signature),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidAttestorSignature");
    });

    it("reverts before the attestor address is configured", async () => {
      const base = await loadFixture(deployFixture);

      const dueAt = await base.dueSoon(7n * 24n * 3600n);
      const attestation: Attestation = {
        seller: base.seller.address,
        buyer: base.buyer.address,
        usdAmountCents: USD_100,
        dueAt,
        termsCommitment: COMMITMENT,
        attestationId: ATTESTATION_ID,
      };
      const signature = await signAttestation(
        base.attestorWallet,
        attestation,
        base.chainId,
        base.escrowAddress,
      );

      await expect(
        base.escrow.connect(base.seller).relayConfidentialInvoice(attestation, signature),
      ).to.be.revertedWithCustomError(base.escrow, "AttestorNotConfigured");
    });

    it("rejects an attestation signed by a wallet that is not the configured attestor", async () => {
      const ctx = await loadFixture(confidentialFixture);

      const rogue = await signAttestation(
        ctx.rogueWallet,
        ctx.attestation,
        ctx.chainId,
        ctx.escrowAddress,
      );

      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(ctx.attestation, rogue),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidAttestorSignature");
    });

    it("rejects relay by anyone other than the named seller", async () => {
      const ctx = await loadFixture(confidentialFixture);

      await expect(
        ctx.escrow.connect(ctx.stranger).relayConfidentialInvoice(ctx.attestation, ctx.signature),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidResultSeller");
    });

    it("rejects replay of an already consumed attestation id", async () => {
      const ctx = await loadFixture(confidentialFixture);

      await ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(ctx.attestation, ctx.signature);

      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(ctx.attestation, ctx.signature),
      ).to.be.revertedWithCustomError(ctx.escrow, "AttestationAlreadyConsumed");
    });

    it("rejects a zero attestation id", async () => {
      const ctx = await loadFixture(confidentialFixture);

      const attestation = { ...ctx.attestation, attestationId: ZERO_BYTES32 };
      const signature = await signAttestation(
        ctx.attestorWallet,
        attestation,
        ctx.chainId,
        ctx.escrowAddress,
      );

      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(attestation, signature),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidAttestationId");
    });

    it("rejects a signed attestation carrying a zero buyer", async () => {
      const ctx = await loadFixture(confidentialFixture);

      const attestation = { ...ctx.attestation, buyer: ZERO_ADDRESS };
      const signature = await signAttestation(
        ctx.attestorWallet,
        attestation,
        ctx.chainId,
        ctx.escrowAddress,
      );

      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(attestation, signature),
      ).to.be.revertedWithCustomError(ctx.escrow, "ZeroAddress");
    });

    it("rejects a signed attestation carrying a zero amount", async () => {
      const ctx = await loadFixture(confidentialFixture);

      const attestation = { ...ctx.attestation, usdAmountCents: 0n };
      const signature = await signAttestation(
        ctx.attestorWallet,
        attestation,
        ctx.chainId,
        ctx.escrowAddress,
      );

      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(attestation, signature),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidAmount");
    });

    it("rejects a signed attestation carrying a past due date", async () => {
      const ctx = await loadFixture(confidentialFixture);

      const attestation = { ...ctx.attestation, dueAt: BigInt(await time.latest()) - 1n };
      const signature = await signAttestation(
        ctx.attestorWallet,
        attestation,
        ctx.chainId,
        ctx.escrowAddress,
      );

      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(attestation, signature),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidDueDate");
    });

    it("rejects a signed attestation carrying a zero commitment", async () => {
      const ctx = await loadFixture(confidentialFixture);

      const attestation = { ...ctx.attestation, termsCommitment: ZERO_BYTES32 };
      const signature = await signAttestation(
        ctx.attestorWallet,
        attestation,
        ctx.chainId,
        ctx.escrowAddress,
      );

      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(attestation, signature),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidCommitment");
    });

    it("does not consume the attestation id when the relay reverts", async () => {
      const ctx = await loadFixture(confidentialFixture);

      const attestation = { ...ctx.attestation, buyer: ZERO_ADDRESS };
      const signature = await signAttestation(
        ctx.attestorWallet,
        attestation,
        ctx.chainId,
        ctx.escrowAddress,
      );

      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(attestation, signature),
      ).to.be.revertedWithCustomError(ctx.escrow, "ZeroAddress");

      expect(await ctx.escrow.consumedAttestationIds(ATTESTATION_ID)).to.equal(false);

      // The original, well-formed attestation still works afterwards.
      await expect(
        ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(ctx.attestation, ctx.signature),
      ).to.emit(ctx.escrow, "InvoiceCreated");
    });
  });

  // -------------------------------------------------------------------
  // quoteInvoice
  // -------------------------------------------------------------------

  describe("quoteInvoice", () => {
    it("converts $100.00 to exactly 100 USDT", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createPendingInvoice(ctx);

      expect(await ctx.escrow.quoteInvoice(invoiceId)).to.equal(USD_100_IN_TOKENS);
    });

    it("converts a single cent to exactly 10^4 base units", async () => {
      const ctx = await loadFixture(deployFixture);
      const dueAt = await ctx.dueSoon(3600n);
      await ctx.escrow
        .connect(ctx.seller)
        .createPublicInvoice(ctx.buyer.address, COMMITMENT, 1n, dueAt);

      expect(await ctx.escrow.quoteInvoice(1n)).to.equal(10_000n);
    });

    it("converts a non-round amount exactly, with no rounding loss", async () => {
      const ctx = await loadFixture(deployFixture);
      const dueAt = await ctx.dueSoon(3600n);
      const cents = 123_456_789n; // $1,234,567.89
      await ctx.escrow
        .connect(ctx.seller)
        .createPublicInvoice(ctx.buyer.address, COMMITMENT, cents, dueAt);

      expect(await ctx.escrow.quoteInvoice(1n)).to.equal(cents * 10_000n);
    });

    it("is a view function that needs no price feed and cannot move between quote and funding", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createPendingInvoice(ctx);

      const first = await ctx.escrow.quoteInvoice(invoiceId);
      await time.increase(30n * 24n * 3600n); // a month later
      const second = await ctx.escrow.quoteInvoice(invoiceId);

      expect(second).to.equal(first);
    });

    it("reverts for an unknown invoice", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.escrow.quoteInvoice(99n)).to.be.revertedWithCustomError(
        ctx.escrow,
        "InvoiceNotFound",
      );
    });

    it("reverts for an invoice that is no longer pending", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createFundedInvoice(ctx);

      await expect(ctx.escrow.quoteInvoice(invoiceId)).to.be.revertedWithCustomError(
        ctx.escrow,
        "InvalidStatus",
      );
    });
  });

  // -------------------------------------------------------------------
  // fundInvoice
  // -------------------------------------------------------------------

  describe("fundInvoice", () => {
    it("transfers exactly the quoted amount and records it", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createPendingInvoice(ctx);

      const required = await ctx.escrow.quoteInvoice(invoiceId);
      expect(required).to.equal(USD_100_IN_TOKENS);

      await ctx.token.connect(ctx.buyer).approve(ctx.escrowAddress, required);

      const fundTx = ctx.escrow.connect(ctx.buyer).fundInvoice(invoiceId);
      await expect(fundTx).to.changeTokenBalances(
        ctx.token,
        [ctx.buyer, ctx.escrowAddress],
        [-required, required],
      );
      await expect(fundTx)
        .to.emit(ctx.escrow, "InvoiceFunded")
        .withArgs(invoiceId, ctx.buyer.address, required);

      const invoice = await ctx.escrow.getInvoice(invoiceId);
      expect(invoice.tokenAmount).to.equal(required);
      expect(invoice.status).to.equal(2n); // Funded
      expect(await ctx.escrow.totalEscrowed()).to.equal(required);
    });

    it("computes the amount itself rather than trusting the caller", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createPendingInvoice(ctx);

      // Approve far more than required; the contract must still take exactly the quote.
      await ctx.token.connect(ctx.buyer).approve(ctx.escrowAddress, 1_000_000n * TOKEN_SCALE);
      await ctx.escrow.connect(ctx.buyer).fundInvoice(invoiceId);

      expect((await ctx.escrow.getInvoice(invoiceId)).tokenAmount).to.equal(USD_100_IN_TOKENS);
      expect(await ctx.token.balanceOf(ctx.escrowAddress)).to.equal(USD_100_IN_TOKENS);
    });

    it("rejects funding by anyone other than the named buyer", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createPendingInvoice(ctx);

      await ctx.token.connect(ctx.buyer).approve(ctx.escrowAddress, USD_100_IN_TOKENS);
      await expect(
        ctx.escrow.connect(ctx.stranger).fundInvoice(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "NotBuyer");
    });

    it("reverts when the allowance is insufficient", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createPendingInvoice(ctx);

      await ctx.token.connect(ctx.buyer).approve(ctx.escrowAddress, USD_100_IN_TOKENS - 1n);
      await expect(
        ctx.escrow.connect(ctx.buyer).fundInvoice(invoiceId),
      ).to.be.revertedWithCustomError(ctx.token, "ERC20InsufficientAllowance");
    });

    it("reverts when the buyer's balance is insufficient", async () => {
      const ctx = await loadFixture(deployFixture);
      const dueAt = await ctx.dueSoon(3600n);
      // $10,000,000.00 — more than the buyer's 1,000,000 USDT.
      await ctx.escrow
        .connect(ctx.seller)
        .createPublicInvoice(ctx.buyer.address, COMMITMENT, 1_000_000_000n, dueAt);

      const required = await ctx.escrow.quoteInvoice(1n);
      await ctx.token.connect(ctx.buyer).approve(ctx.escrowAddress, required);

      await expect(ctx.escrow.connect(ctx.buyer).fundInvoice(1n)).to.be.revertedWithCustomError(
        ctx.token,
        "ERC20InsufficientBalance",
      );
    });

    it("rejects funding after the due date", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId, dueAt } = await createPendingInvoice(ctx);

      await ctx.token.connect(ctx.buyer).approve(ctx.escrowAddress, USD_100_IN_TOKENS);
      await time.increaseTo(dueAt + 1n);

      await expect(
        ctx.escrow.connect(ctx.buyer).fundInvoice(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvoiceExpired");
    });

    it("cannot fund the same invoice twice", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createFundedInvoice(ctx);

      await ctx.token.connect(ctx.buyer).approve(ctx.escrowAddress, USD_100_IN_TOKENS);
      await expect(
        ctx.escrow.connect(ctx.buyer).fundInvoice(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidStatus");
    });

    it("reverts for an unknown invoice", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.escrow.connect(ctx.buyer).fundInvoice(99n)).to.be.revertedWithCustomError(
        ctx.escrow,
        "InvoiceNotFound",
      );
    });
  });

  // -------------------------------------------------------------------
  // releasePayment
  // -------------------------------------------------------------------

  describe("releasePayment", () => {
    it("pays the seller the exact escrowed amount", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId, required } = await createFundedInvoice(ctx);

      const releaseTx = ctx.escrow.connect(ctx.buyer).releasePayment(invoiceId);
      await expect(releaseTx).to.changeTokenBalances(
        ctx.token,
        [ctx.escrowAddress, ctx.seller],
        [-required, required],
      );
      await expect(releaseTx)
        .to.emit(ctx.escrow, "InvoiceReleased")
        .withArgs(invoiceId, ctx.seller.address, required);

      expect((await ctx.escrow.getInvoice(invoiceId)).status).to.equal(3n); // Released
      expect(await ctx.escrow.totalEscrowed()).to.equal(0n);
    });

    it("rejects release by the seller", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createFundedInvoice(ctx);

      await expect(
        ctx.escrow.connect(ctx.seller).releasePayment(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "NotBuyer");
    });

    it("rejects release by an unrelated wallet", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createFundedInvoice(ctx);

      await expect(
        ctx.escrow.connect(ctx.stranger).releasePayment(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "NotBuyer");
    });

    it("cannot release twice", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createFundedInvoice(ctx);

      await ctx.escrow.connect(ctx.buyer).releasePayment(invoiceId);
      await expect(
        ctx.escrow.connect(ctx.buyer).releasePayment(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidStatus");
    });

    it("cannot release an invoice that was never funded", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createPendingInvoice(ctx);

      await expect(
        ctx.escrow.connect(ctx.buyer).releasePayment(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidStatus");
    });
  });

  // -------------------------------------------------------------------
  // refundBuyer
  // -------------------------------------------------------------------

  describe("refundBuyer", () => {
    it("returns the exact amount to the buyer", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId, required } = await createFundedInvoice(ctx);

      const refundTx = ctx.escrow.connect(ctx.seller).refundBuyer(invoiceId);
      await expect(refundTx).to.changeTokenBalances(
        ctx.token,
        [ctx.escrowAddress, ctx.buyer],
        [-required, required],
      );
      await expect(refundTx)
        .to.emit(ctx.escrow, "InvoiceRefunded")
        .withArgs(invoiceId, ctx.buyer.address, required, false);

      expect((await ctx.escrow.getInvoice(invoiceId)).status).to.equal(4n); // Refunded
      expect(await ctx.escrow.totalEscrowed()).to.equal(0n);
    });

    it("rejects a buyer calling the seller refund path", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createFundedInvoice(ctx);

      await expect(
        ctx.escrow.connect(ctx.buyer).refundBuyer(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "NotSeller");
    });

    it("cannot refund twice", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createFundedInvoice(ctx);

      await ctx.escrow.connect(ctx.seller).refundBuyer(invoiceId);
      await expect(
        ctx.escrow.connect(ctx.seller).refundBuyer(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidStatus");
    });
  });

  // -------------------------------------------------------------------
  // claimExpiredRefund
  // -------------------------------------------------------------------

  describe("claimExpiredRefund", () => {
    it("rejects a claim before the grace period elapses", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId, dueAt } = await createFundedInvoice(ctx);

      await time.increaseTo(dueAt + REFUND_GRACE_PERIOD - 10n);
      await expect(
        ctx.escrow.connect(ctx.buyer).claimExpiredRefund(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "RefundNotAvailable");
    });

    it("allows the buyer to reclaim after the grace period", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId, dueAt, required } = await createFundedInvoice(ctx);

      await time.increaseTo(dueAt + REFUND_GRACE_PERIOD + 1n);

      const claimTx = ctx.escrow.connect(ctx.buyer).claimExpiredRefund(invoiceId);
      await expect(claimTx).to.changeTokenBalances(
        ctx.token,
        [ctx.escrowAddress, ctx.buyer],
        [-required, required],
      );
      await expect(claimTx)
        .to.emit(ctx.escrow, "InvoiceRefunded")
        .withArgs(invoiceId, ctx.buyer.address, required, true);
    });

    it("rejects a claim by a non-buyer", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId, dueAt } = await createFundedInvoice(ctx);

      await time.increaseTo(dueAt + REFUND_GRACE_PERIOD + 1n);
      await expect(
        ctx.escrow.connect(ctx.stranger).claimExpiredRefund(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "NotBuyer");
    });
  });

  // -------------------------------------------------------------------
  // cancelInvoice
  // -------------------------------------------------------------------

  describe("cancelInvoice", () => {
    it("lets the seller cancel a pending invoice", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createPendingInvoice(ctx);

      await expect(ctx.escrow.connect(ctx.seller).cancelInvoice(invoiceId))
        .to.emit(ctx.escrow, "InvoiceCancelled")
        .withArgs(invoiceId);

      expect((await ctx.escrow.getInvoice(invoiceId)).status).to.equal(5n); // Cancelled
    });

    it("rejects cancellation by the buyer", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createPendingInvoice(ctx);

      await expect(
        ctx.escrow.connect(ctx.buyer).cancelInvoice(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "NotSeller");
    });

    it("cannot cancel a funded invoice", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createFundedInvoice(ctx);

      await expect(
        ctx.escrow.connect(ctx.seller).cancelInvoice(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "InvalidStatus");
    });
  });

  // -------------------------------------------------------------------
  // Administration
  // -------------------------------------------------------------------

  describe("Administration", () => {
    it("only the owner can set the attestor address", async () => {
      const ctx = await loadFixture(deployFixture);

      await expect(
        ctx.escrow.connect(ctx.stranger).setAttestorAddress(ctx.attestorWallet.address),
      ).to.be.revertedWithCustomError(ctx.escrow, "OwnableUnauthorizedAccount");

      await expect(ctx.escrow.connect(ctx.owner).setAttestorAddress(ctx.attestorWallet.address))
        .to.emit(ctx.escrow, "AttestorAddressUpdated")
        .withArgs(ZERO_ADDRESS, ctx.attestorWallet.address);

      expect(await ctx.escrow.attestorAddress()).to.equal(ctx.attestorWallet.address);
    });

    it("rejects a zero attestor address", async () => {
      const ctx = await loadFixture(deployFixture);

      await expect(
        ctx.escrow.connect(ctx.owner).setAttestorAddress(ZERO_ADDRESS),
      ).to.be.revertedWithCustomError(ctx.escrow, "ZeroAddress");
    });

    it("rotating the attestor does not invalidate existing invoices", async () => {
      const ctx = await loadFixture(confidentialFixture);
      await ctx.escrow.connect(ctx.seller).relayConfidentialInvoice(ctx.attestation, ctx.signature);

      await ctx.escrow.connect(ctx.owner).setAttestorAddress(ctx.rogueWallet.address);

      const invoice = await ctx.escrow.getInvoice(1n);
      expect(invoice.confidential).to.equal(true);

      await ctx.token.connect(ctx.buyer).approve(ctx.escrowAddress, USD_100_IN_TOKENS);
      await expect(ctx.escrow.connect(ctx.buyer).fundInvoice(1n)).to.emit(
        ctx.escrow,
        "InvoiceFunded",
      );
    });

    it("owner can pause and unpause, and mutating flows revert while paused", async () => {
      const ctx = await loadFixture(deployFixture);
      const { invoiceId } = await createPendingInvoice(ctx);
      const dueAt = await ctx.dueSoon(3600n);

      await ctx.escrow.connect(ctx.owner).pause();

      await ctx.token.connect(ctx.buyer).approve(ctx.escrowAddress, USD_100_IN_TOKENS);
      await expect(
        ctx.escrow.connect(ctx.buyer).fundInvoice(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "EnforcedPause");
      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .createPublicInvoice(ctx.buyer.address, COMMITMENT, USD_100, dueAt),
      ).to.be.revertedWithCustomError(ctx.escrow, "EnforcedPause");
      await expect(
        ctx.escrow.connect(ctx.seller).cancelInvoice(invoiceId),
      ).to.be.revertedWithCustomError(ctx.escrow, "EnforcedPause");

      await ctx.escrow.connect(ctx.owner).unpause();
      await expect(ctx.escrow.connect(ctx.buyer).fundInvoice(invoiceId)).to.emit(
        ctx.escrow,
        "InvoiceFunded",
      );
    });

    it("only the owner can pause", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.escrow.connect(ctx.stranger).pause()).to.be.revertedWithCustomError(
        ctx.escrow,
        "OwnableUnauthorizedAccount",
      );
    });

    it("the owner cannot withdraw escrowed settlement tokens", async () => {
      const ctx = await loadFixture(deployFixture);
      const { required } = await createFundedInvoice(ctx);

      await expect(
        ctx.escrow
          .connect(ctx.owner)
          .recoverUnsupportedToken(await ctx.token.getAddress(), ctx.owner.address, required),
      ).to.be.revertedWithCustomError(ctx.escrow, "CannotRecoverEscrowToken");

      expect(await ctx.token.balanceOf(ctx.escrowAddress)).to.equal(required);
    });

    it("recovers a genuinely unsupported token", async () => {
      const ctx = await loadFixture(deployFixture);

      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const stray = await MockERC20Factory.deploy("Stray", "STRAY", 18);
      await stray.waitForDeployment();

      const amount = ethers.parseEther("5");
      await stray.mint(ctx.escrowAddress, amount);

      await expect(
        ctx.escrow
          .connect(ctx.owner)
          .recoverUnsupportedToken(await stray.getAddress(), ctx.stranger.address, amount),
      ).to.changeTokenBalances(stray, [ctx.escrowAddress, ctx.stranger], [-amount, amount]);
    });

    it("rejects recovery to the zero address", async () => {
      const ctx = await loadFixture(deployFixture);

      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const stray = await MockERC20Factory.deploy("Stray", "STRAY", 18);
      await stray.waitForDeployment();

      await expect(
        ctx.escrow
          .connect(ctx.owner)
          .recoverUnsupportedToken(await stray.getAddress(), ZERO_ADDRESS, 1n),
      ).to.be.revertedWithCustomError(ctx.escrow, "ZeroAddress");
    });
  });

  // -------------------------------------------------------------------
  // End to end
  // -------------------------------------------------------------------

  describe("End-to-end confidential lifecycle", () => {
    it("relays an attestation, funds, and releases with no plaintext on-chain", async () => {
      const ctx = await loadFixture(confidentialFixture);

      // 1. Seller relays the attestor-signed settlement facts.
      const relayTx = await ctx.escrow
        .connect(ctx.seller)
        .relayConfidentialInvoice(ctx.attestation, ctx.signature);
      const receipt = await relayTx.wait();

      // 2. Nothing beyond the public settlement facts reaches the chain. The commitment is the
      //    only trace of the private terms, and it is a hash.
      const invoice = await ctx.escrow.getInvoice(1n);
      expect(invoice.termsCommitment).to.equal(COMMITMENT);
      expect(invoice.confidential).to.equal(true);
      expect(invoice.usdAmountCents).to.equal(USD_100);

      const invoiceFields = (
        ctx.escrow.interface.getFunction("getInvoice")!.outputs[0].components ?? []
      ).map((component) => component.name);
      expect(invoiceFields).to.include("termsCommitment");
      expect(invoiceFields).to.not.include("lineItems");
      expect(invoiceFields).to.not.include("description");
      expect(invoiceFields).to.not.include("customer");

      // The calldata carries only the six attested fields plus the signature — no ciphertext,
      // and nothing that could be decoded back into line items.
      const relayCalldata = (await ethers.provider.getTransaction(relayTx.hash))!.data;
      expect(relayCalldata.length).to.be.lessThan(2 + 2 * 500);

      // 3. Buyer funds at the fixed stablecoin amount.
      const required = await ctx.escrow.quoteInvoice(1n);
      expect(required).to.equal(USD_100_IN_TOKENS);

      await ctx.token.connect(ctx.buyer).approve(ctx.escrowAddress, required);
      await ctx.escrow.connect(ctx.buyer).fundInvoice(1n);
      expect(await ctx.escrow.totalEscrowed()).to.equal(required);

      // 4. Buyer releases to the seller.
      await expect(ctx.escrow.connect(ctx.buyer).releasePayment(1n)).to.changeTokenBalances(
        ctx.token,
        [ctx.escrowAddress, ctx.seller],
        [-required, required],
      );

      expect((await ctx.escrow.getInvoice(1n)).status).to.equal(3n); // Released
      expect(await ctx.escrow.totalEscrowed()).to.equal(0n);
      expect(receipt!.status).to.equal(1);
    });
  });
});
