import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-network-helpers";
import "@typechain/hardhat";
import "solidity-coverage";
import * as dotenv from "dotenv";

dotenv.config();

// Public RPCs by default; override with your own for reliability. Production is Polygon; Sepolia is
// the test network Nimiq Pay supports for EVM development.
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com";
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org";

// Never fall back to a literal key. An unset key simply means the network has no signer configured
// and deployment scripts fail loudly instead of silently using someone else's account.
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
const accounts = deployerKey && deployerKey.length > 0 ? [deployerKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
      // Polygon and Sepolia both run the Cancun fork, so OpenZeppelin v5's transient-storage
      // opcodes (MCOPY/TSTORE/TLOAD) are safe.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      // Defaults to Sepolia's id so a local rehearsal of the confidential flow — whose EIP-712
      // domain binds chainId — matches a Sepolia deployment. Overridable for anything else.
      chainId: Number(process.env.HARDHAT_CHAIN_ID ?? 11155111),
      allowUnlimitedContractSize: false,
    },
    // Production deployment target.
    polygon: {
      url: POLYGON_RPC_URL,
      chainId: 137,
      accounts,
      timeout: 60_000,
    },
    // Test network for rehearsal before spending real value.
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts,
      timeout: 60_000,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 120000,
  },
};

export default config;
