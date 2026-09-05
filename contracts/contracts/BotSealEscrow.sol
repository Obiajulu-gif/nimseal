// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title BotSealEscrow
 * @notice Confidential invoice escrow settled in a USD stablecoin (USDT) on an EVM chain that
 *         Nimiq Pay exposes — Polygon in production, Sepolia for testing.
 *
 * @dev Privacy model. Invoice line items, descriptions, customer identities, tax identifiers, the
 *      nonce and the salt never touch this contract. They are encrypted in the browser to the
 *      attestor's public key, validated off-chain, and only a minimal public result is signed and
 *      relayed back: seller, buyer, total in USD cents, due date, and a `termsCommitment` binding
 *      the full private terms. This contract stores and emits only that public result.
 *
 *      The attestor is a server-side signing key operated by this project. It is NOT a trusted
 *      execution environment and carries no hardware attestation — an operator with server access
 *      can read invoice plaintext while it is being validated. What the design does guarantee is
 *      that the plaintext never reaches the chain, that the commitment binds the private terms,
 *      that the total was validated before it was signed, and that a signed result cannot be
 *      replayed. See docs/SECURITY.md.
 *
 * @dev Economic model. Invoices are denominated in USD cents and settled in a USD stablecoin, so
 *      there is no price feed, no staleness window and no slippage: the amount due is a pure
 *      decimal conversion, fixed the moment the invoice is created. This is deliberate — pricing a
 *      USD invoice in a USD asset through an oracle would add trust and failure modes to buy
 *      nothing.
 */
contract BotSealEscrow is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum InvoiceStatus {
        None,
        Pending,
        Funded,
        Released,
        Refunded,
        Cancelled
    }

    struct Invoice {
        uint256 id;
        address seller;
        address buyer;
        bytes32 termsCommitment;
        bytes32 attestationId;
        uint256 usdAmountCents;
        uint256 tokenAmount;
        uint64 dueAt;
        uint64 createdAt;
        uint64 fundedAt;
        uint64 settledAt;
        bool confidential;
        InvoiceStatus status;
    }

    /**
     * @notice The settlement facts the attestor signs after validating a private invoice.
     * @dev There is deliberately no `escrowContract` field. The EIP-712 domain already binds every
     *      signature to this contract address and this chain id, so a signature minted for another
     *      deployment cannot verify here. A redundant field would only be a second thing to check.
     */
    struct ConfidentialInvoice {
        address seller;
        address buyer;
        uint256 usdAmountCents;
        uint64 dueAt;
        bytes32 termsCommitment;
        bytes32 attestationId;
    }

    // ---------------------------------------------------------------------
    // Constants and immutables
    // ---------------------------------------------------------------------

    bytes32 private constant CONFIDENTIAL_INVOICE_TYPEHASH =
        keccak256(
            "ConfidentialInvoice(address seller,address buyer,uint256 usdAmountCents,uint64 dueAt,bytes32 termsCommitment,bytes32 attestationId)"
        );

    /// @dev USD cents per whole USD. Invoices are integer cents; the token is a USD stablecoin.
    uint256 private constant CENTS_PER_USD = 100;

    /// @notice The USD stablecoin every invoice is escrowed and settled in.
    IERC20Metadata public immutable SETTLEMENT_TOKEN;

    /// @notice `10 ** SETTLEMENT_TOKEN.decimals()`, cached at construction so funding cannot be
    ///         re-priced by a token that later changes its reported decimals.
    uint256 public immutable tokenScale;

    /// @notice Extra time after `dueAt` before a buyer may unilaterally reclaim a funded escrow.
    uint256 public immutable refundGracePeriod;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    uint256 public nextInvoiceId = 1;
    uint256 public totalEscrowed;

    /// @notice The attestor signing address whose signatures this escrow accepts.
    address public attestorAddress;

    mapping(uint256 => Invoice) private invoices;
    mapping(bytes32 => bool) public consumedAttestationIds;
    mapping(address => uint256[]) private sellerInvoiceIds;
    mapping(address => uint256[]) private buyerInvoiceIds;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error NotAContract();
    error InvalidAmount();
    error InvalidDueDate();
    error InvalidCommitment();
    error InvoiceNotFound();
    error InvalidStatus();
    error NotSeller();
    error NotBuyer();
    error InvoiceExpired();
    error RefundNotAvailable();
    error AttestorNotConfigured();
    error InvalidAttestorSignature();
    error AttestationAlreadyConsumed();
    error InvalidResultSeller();
    error InvalidAttestationId();
    error UnsupportedTokenDecimals();
    error SameSellerAndBuyer();
    error CannotRecoverEscrowToken();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event InvoiceCreated(
        uint256 indexed invoiceId,
        address indexed seller,
        address indexed buyer,
        bytes32 termsCommitment,
        uint256 usdAmountCents,
        uint64 dueAt,
        bool confidential,
        bytes32 attestationId
    );

    event InvoiceFunded(uint256 indexed invoiceId, address indexed buyer, uint256 tokenAmount);

    event InvoiceReleased(uint256 indexed invoiceId, address indexed seller, uint256 tokenAmount);

    event InvoiceRefunded(
        uint256 indexed invoiceId,
        address indexed buyer,
        uint256 tokenAmount,
        bool expiredRefund
    );

    event InvoiceCancelled(uint256 indexed invoiceId);

    event AttestorAddressUpdated(address indexed previousAddress, address indexed newAddress);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(
        address initialOwner,
        address settlementToken,
        uint256 refundGracePeriodSeconds
    ) Ownable(initialOwner) EIP712("BotSeal", "1") {
        if (settlementToken == address(0)) revert ZeroAddress();
        if (settlementToken.code.length == 0) revert NotAContract();

        uint8 tokenDecimals = IERC20Metadata(settlementToken).decimals();
        if (tokenDecimals > 18) revert UnsupportedTokenDecimals();

        SETTLEMENT_TOKEN = IERC20Metadata(settlementToken);
        tokenScale = 10 ** tokenDecimals;
        refundGracePeriod = refundGracePeriodSeconds;
    }

    // ---------------------------------------------------------------------
    // Invoice creation - public fallback mode
    // ---------------------------------------------------------------------

    /**
     * @notice Creates a non-confidential invoice directly, bypassing the attestor.
     * @dev Continuity path used when the attestor service is unavailable. The commitment is
     *      supplied by the caller and was validated by nobody, so a public invoice proves only
     *      that the seller asserted these terms. The UI labels every invoice created this way.
     */
    function createPublicInvoice(
        address buyer,
        bytes32 termsCommitment,
        uint256 usdAmountCents,
        uint64 dueAt
    ) external whenNotPaused returns (uint256 invoiceId) {
        return
            _createInvoice(
                msg.sender,
                buyer,
                termsCommitment,
                usdAmountCents,
                dueAt,
                false,
                bytes32(0)
            );
    }

    // ---------------------------------------------------------------------
    // Invoice creation - confidential attestor relay
    // ---------------------------------------------------------------------

    /**
     * @notice Relays an attestor-signed settlement result and creates the corresponding invoice.
     *
     * @param attestation The settlement facts the attestor validated and signed.
     * @param signature   65-byte EIP-712 signature over {attestation} by {attestorAddress}.
     *
     * @dev The seller submits this themselves, so the invoice cannot be created on their behalf by
     *      anyone holding a copy of the signature. `attestationId` is single-use for the lifetime
     *      of this contract, which is what stops a valid signature being replayed into a second
     *      invoice.
     */
    function relayConfidentialInvoice(
        ConfidentialInvoice calldata attestation,
        bytes calldata signature
    ) external whenNotPaused returns (uint256 invoiceId) {
        if (attestorAddress == address(0)) revert AttestorNotConfigured();
        if (attestation.attestationId == bytes32(0)) revert InvalidAttestationId();
        if (consumedAttestationIds[attestation.attestationId]) revert AttestationAlreadyConsumed();
        if (attestation.seller != msg.sender) revert InvalidResultSeller();

        _verifyAttestorSignature(attestation, signature);

        consumedAttestationIds[attestation.attestationId] = true;

        return
            _createInvoice(
                attestation.seller,
                attestation.buyer,
                attestation.termsCommitment,
                attestation.usdAmountCents,
                attestation.dueAt,
                true,
                attestation.attestationId
            );
    }

    /**
     * @notice The EIP-712 digest an attestor must sign for `attestation`.
     * @dev Exposed so the attestor service and its tests can assert they are signing exactly what
     *      this contract will verify, rather than reimplementing the encoding and hoping.
     */
    function hashConfidentialInvoice(
        ConfidentialInvoice calldata attestation
    ) public view returns (bytes32) {
        return _hashTypedDataV4(_structHash(attestation));
    }

    function _structHash(
        ConfidentialInvoice calldata attestation
    ) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    CONFIDENTIAL_INVOICE_TYPEHASH,
                    attestation.seller,
                    attestation.buyer,
                    attestation.usdAmountCents,
                    attestation.dueAt,
                    attestation.termsCommitment,
                    attestation.attestationId
                )
            );
    }

    function _verifyAttestorSignature(
        ConfidentialInvoice calldata attestation,
        bytes calldata signature
    ) private view {
        address recovered = ECDSA.recover(
            _hashTypedDataV4(_structHash(attestation)),
            signature
        );
        if (recovered != attestorAddress) revert InvalidAttestorSignature();
    }

    // ---------------------------------------------------------------------
    // Pricing
    // ---------------------------------------------------------------------

    /**
     * @notice Returns the settlement-token amount required to fund `invoiceId`.
     * @dev A plain `view`. With stablecoin settlement the amount is fixed when the invoice is
     *      created, so — unlike the oracle-priced version this replaces — it cannot move between
     *      the quote and the funding transaction, and needs no slippage ceiling.
     */
    function quoteInvoice(uint256 invoiceId) external view returns (uint256 requiredAmount) {
        Invoice storage invoice = invoices[invoiceId];
        if (invoice.status == InvoiceStatus.None) revert InvoiceNotFound();
        if (invoice.status != InvoiceStatus.Pending) revert InvalidStatus();

        return _usdCentsToTokens(invoice.usdAmountCents);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @notice Buyer funds the escrow with the settlement token.
    function fundInvoice(uint256 invoiceId) external nonReentrant whenNotPaused {
        Invoice storage invoice = invoices[invoiceId];
        if (invoice.status == InvoiceStatus.None) revert InvoiceNotFound();
        if (invoice.status != InvoiceStatus.Pending) revert InvalidStatus();
        if (msg.sender != invoice.buyer) revert NotBuyer();
        if (block.timestamp > invoice.dueAt) revert InvoiceExpired();

        uint256 requiredAmount = _usdCentsToTokens(invoice.usdAmountCents);

        // Effects before interaction.
        invoice.tokenAmount = requiredAmount;
        invoice.fundedAt = uint64(block.timestamp);
        invoice.status = InvoiceStatus.Funded;
        totalEscrowed += requiredAmount;

        emit InvoiceFunded(invoiceId, msg.sender, requiredAmount);

        IERC20(address(SETTLEMENT_TOKEN)).safeTransferFrom(
            msg.sender,
            address(this),
            requiredAmount
        );
    }

    /// @notice Buyer releases a funded escrow to the seller.
    function releasePayment(uint256 invoiceId) external nonReentrant whenNotPaused {
        Invoice storage invoice = invoices[invoiceId];
        if (invoice.status == InvoiceStatus.None) revert InvoiceNotFound();
        if (invoice.status != InvoiceStatus.Funded) revert InvalidStatus();
        if (msg.sender != invoice.buyer) revert NotBuyer();

        uint256 amount = invoice.tokenAmount;
        address seller = invoice.seller;

        invoice.status = InvoiceStatus.Released;
        invoice.settledAt = uint64(block.timestamp);
        totalEscrowed -= amount;

        emit InvoiceReleased(invoiceId, seller, amount);

        IERC20(address(SETTLEMENT_TOKEN)).safeTransfer(seller, amount);
    }

    /// @notice Seller voluntarily returns a funded escrow to the buyer.
    function refundBuyer(uint256 invoiceId) external nonReentrant whenNotPaused {
        Invoice storage invoice = invoices[invoiceId];
        if (invoice.status == InvoiceStatus.None) revert InvoiceNotFound();
        if (invoice.status != InvoiceStatus.Funded) revert InvalidStatus();
        if (msg.sender != invoice.seller) revert NotSeller();

        uint256 amount = invoice.tokenAmount;
        address buyer = invoice.buyer;

        invoice.status = InvoiceStatus.Refunded;
        invoice.settledAt = uint64(block.timestamp);
        totalEscrowed -= amount;

        emit InvoiceRefunded(invoiceId, buyer, amount, false);

        IERC20(address(SETTLEMENT_TOKEN)).safeTransfer(buyer, amount);
    }

    /**
     * @notice Buyer reclaims a funded escrow the seller never released.
     * @dev Available only after `dueAt + refundGracePeriod`, so a seller who delivered late still
     *      has a bounded window to be paid before the buyer can unwind the escrow.
     */
    function claimExpiredRefund(uint256 invoiceId) external nonReentrant whenNotPaused {
        Invoice storage invoice = invoices[invoiceId];
        if (invoice.status == InvoiceStatus.None) revert InvoiceNotFound();
        if (invoice.status != InvoiceStatus.Funded) revert InvalidStatus();
        if (msg.sender != invoice.buyer) revert NotBuyer();
        if (block.timestamp <= uint256(invoice.dueAt) + refundGracePeriod) {
            revert RefundNotAvailable();
        }

        uint256 amount = invoice.tokenAmount;

        invoice.status = InvoiceStatus.Refunded;
        invoice.settledAt = uint64(block.timestamp);
        totalEscrowed -= amount;

        emit InvoiceRefunded(invoiceId, msg.sender, amount, true);

        IERC20(address(SETTLEMENT_TOKEN)).safeTransfer(msg.sender, amount);
    }

    /// @notice Seller cancels a pending, unfunded invoice.
    function cancelInvoice(uint256 invoiceId) external whenNotPaused {
        Invoice storage invoice = invoices[invoiceId];
        if (invoice.status == InvoiceStatus.None) revert InvoiceNotFound();
        if (invoice.status != InvoiceStatus.Pending) revert InvalidStatus();
        if (msg.sender != invoice.seller) revert NotSeller();

        invoice.status = InvoiceStatus.Cancelled;
        invoice.settledAt = uint64(block.timestamp);

        emit InvoiceCancelled(invoiceId);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getInvoice(uint256 invoiceId) external view returns (Invoice memory) {
        Invoice memory invoice = invoices[invoiceId];
        if (invoice.status == InvoiceStatus.None) revert InvoiceNotFound();
        return invoice;
    }

    function getSellerInvoiceIds(address seller) external view returns (uint256[] memory) {
        return sellerInvoiceIds[seller];
    }

    function getBuyerInvoiceIds(address buyer) external view returns (uint256[] memory) {
        return buyerInvoiceIds[buyer];
    }

    function invoiceExists(uint256 invoiceId) external view returns (bool) {
        return invoices[invoiceId].status != InvoiceStatus.None;
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /**
     * @notice Sets the attestor signing address used to verify confidential results.
     * @dev Must be the address the attestor service reports from its `/info` endpoint — never the
     *      deployer or the owner. Rotating this address does not invalidate invoices that were
     *      already created.
     */
    function setAttestorAddress(address newAttestorAddress) external onlyOwner {
        if (newAttestorAddress == address(0)) revert ZeroAddress();
        address previous = attestorAddress;
        attestorAddress = newAttestorAddress;
        emit AttestorAddressUpdated(previous, newAttestorAddress);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Recovers tokens accidentally sent to this contract.
     * @dev The settlement token is explicitly rejected: there is no path by which the owner can
     *      touch escrowed funds. Buyers' and sellers' balances are only ever movable by
     *      `releasePayment`, `refundBuyer`, or `claimExpiredRefund`.
     */
    function recoverUnsupportedToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(SETTLEMENT_TOKEN)) revert CannotRecoverEscrowToken();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _createInvoice(
        address seller,
        address buyer,
        bytes32 termsCommitment,
        uint256 usdAmountCents,
        uint64 dueAt,
        bool confidential,
        bytes32 attestationId
    ) private returns (uint256 invoiceId) {
        if (buyer == address(0)) revert ZeroAddress();
        if (buyer == seller) revert SameSellerAndBuyer();
        if (termsCommitment == bytes32(0)) revert InvalidCommitment();
        if (usdAmountCents == 0) revert InvalidAmount();
        if (dueAt <= block.timestamp) revert InvalidDueDate();

        invoiceId = nextInvoiceId++;

        invoices[invoiceId] = Invoice({
            id: invoiceId,
            seller: seller,
            buyer: buyer,
            termsCommitment: termsCommitment,
            attestationId: attestationId,
            usdAmountCents: usdAmountCents,
            tokenAmount: 0,
            dueAt: dueAt,
            createdAt: uint64(block.timestamp),
            fundedAt: 0,
            settledAt: 0,
            confidential: confidential,
            status: InvoiceStatus.Pending
        });

        sellerInvoiceIds[seller].push(invoiceId);
        buyerInvoiceIds[buyer].push(invoiceId);

        emit InvoiceCreated(
            invoiceId,
            seller,
            buyer,
            termsCommitment,
            usdAmountCents,
            dueAt,
            confidential,
            attestationId
        );
    }

    /**
     * @dev Converts integer USD cents to settlement-token units.
     *
     *      amount = ceil(cents * 10^decimals / 100)
     *
     *      For a 6-decimal stablecoin such as USDT this is exact — `cents * 10^4` — and the
     *      ceiling never engages. The rounding mode only matters for a hypothetical token with
     *      fewer than two decimals, where rounding up keeps the escrow from being under-funded by
     *      truncation.
     */
    function _usdCentsToTokens(uint256 usdAmountCents) private view returns (uint256) {
        return Math.mulDiv(usdAmountCents, tokenScale, CENTS_PER_USD, Math.Rounding.Ceil);
    }
}
