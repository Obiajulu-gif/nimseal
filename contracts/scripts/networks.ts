import { ethers } from "hardhat";

/**
 * Supported EVM network constants and settlement-token resolution.
 *
 * nimSeal settles in USDT on an EVM chain that Nimiq Pay exposes: Polygon in production, Sepolia
 * for testing. There is no contract registry to discover, so the settlement token is a known
 * address that we verify rather than resolve dynamically.
 */

export const POLYGON_CHAIN_ID = 137n;
export const SEPOLIA_CHAIN_ID = 11155111n;

/**
 * USDT on Polygon (PoS).
 * Canonical Tether USD, 6 decimals. Source: Nimiq Mini Apps chains-and-tokens reference and
 * Polygonscan (0xc2132D05D31c914a87C6611C10748AEb04B58e8F).
 */
export const POLYGON_USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

const POLYGON_EXPLORER = "https://polygonscan.com";
const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";

const ERC20_METADATA_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
];

export interface NetworkInfo {
  chainId: bigint;
  isMainnet: boolean;
  name: string;
  nativeSymbol: string;
  explorerBaseUrl: string;
}

export async function networkInfo(): Promise<NetworkInfo> {
  const { chainId } = await ethers.provider.getNetwork();

  if (chainId === POLYGON_CHAIN_ID) {
    return {
      chainId,
      isMainnet: true,
      name: "Polygon",
      nativeSymbol: "POL",
      explorerBaseUrl: process.env.POLYGON_EXPLORER_BASE_URL?.trim() || POLYGON_EXPLORER,
    };
  }
  if (chainId === SEPOLIA_CHAIN_ID) {
    return {
      chainId,
      isMainnet: false,
      name: "Sepolia",
      nativeSymbol: "ETH",
      explorerBaseUrl: process.env.SEPOLIA_EXPLORER_BASE_URL?.trim() || SEPOLIA_EXPLORER,
    };
  }

  throw new Error(
    `Connected to chain ${chainId}, which is not a supported network. ` +
      `Expected ${POLYGON_CHAIN_ID} (Polygon) or ${SEPOLIA_CHAIN_ID} (Sepolia). ` +
      `Pass --network polygon or --network sepolia.`,
  );
}

export interface SettlementToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * Resolves and verifies the settlement token for the connected network.
 *
 * Polygon defaults to canonical USDT; Sepolia has no canonical USDT, so `SETTLEMENT_TOKEN_ADDRESS`
 * is required there (deploy a 6-decimal MockERC20 first). Every field is read back from chain and
 * checked, and a Polygon token that does not report USDT/6 is refused outright.
 */
export async function resolveSettlementToken(net: NetworkInfo): Promise<SettlementToken> {
  const override = process.env.SETTLEMENT_TOKEN_ADDRESS?.trim();

  let address: string;
  if (override) {
    if (!ethers.isAddress(override)) {
      throw new Error(`SETTLEMENT_TOKEN_ADDRESS is not a valid address: "${override}"`);
    }
    address = ethers.getAddress(override);
  } else if (net.isMainnet) {
    address = ethers.getAddress(POLYGON_USDT);
  } else {
    throw new Error(
      "Sepolia has no canonical USDT. Deploy a 6-decimal MockERC20 and set " +
        "SETTLEMENT_TOKEN_ADDRESS to it before deploying the escrow.",
    );
  }

  const code = await ethers.provider.getCode(address);
  if (code === "0x") {
    throw new Error(`No contract code at ${address} on ${net.name}.`);
  }

  const token = new ethers.Contract(address, ERC20_METADATA_ABI, ethers.provider);
  const [symbol, decimals, name] = await Promise.all([
    token.symbol() as Promise<string>,
    token.decimals() as Promise<bigint>,
    token.name() as Promise<string>,
  ]);

  const decimalsNumber = Number(decimals);

  if (net.isMainnet) {
    // Applies whether the address came from the default or an override. Supplying an address
    // explicitly is not a reason to trust it less carefully.
    if (symbol !== "USDT" || decimalsNumber !== 6) {
      throw new Error(
        `Settlement token at ${address} reports ${symbol}/${decimalsNumber}d, expected USDT/6d. ` +
          `Refusing to deploy against an unexpected token on Polygon.`,
      );
    }
  } else if (decimalsNumber !== 6) {
    // Not fatal on testnet — but a rehearsal at different decimals is not rehearsing production.
    console.warn(
      `WARNING: settlement token reports ${decimalsNumber} decimals, Polygon USDT uses 6. ` +
        `The amount math will differ from production.`,
    );
  }

  if (decimalsNumber > 18) {
    throw new Error(`Settlement token reports ${decimalsNumber} decimals; the escrow supports ≤18.`);
  }
  if (decimalsNumber < 2) {
    throw new Error(
      `Settlement token reports ${decimalsNumber} decimals. Invoices are denominated in USD ` +
        `cents, so a token with fewer than 2 decimals cannot represent them exactly.`,
    );
  }

  return { address, symbol, name, decimals: decimalsNumber };
}

export function txUrl(hash: string, net: NetworkInfo): string {
  return `${net.explorerBaseUrl.replace(/\/+$/, "")}/tx/${hash}`;
}

export function addressUrl(address: string, net: NetworkInfo): string {
  return `${net.explorerBaseUrl.replace(/\/+$/, "")}/address/${address}`;
}
