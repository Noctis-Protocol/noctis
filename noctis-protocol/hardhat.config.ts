import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "hardhat-gas-reporter";
import "solidity-coverage";
import * as dotenv from "dotenv";

dotenv.config();

// ERC-7984 sources need solc 0.8.27 (@openzeppelin/confidential-contracts).
// They are compiled through per-file overrides — NOT by bumping the default
// compiler — so the main 0.8.24 compilation job (and therefore
// NoctisExchangeV2's viaIR output, which sits close to the EIP-170 limit)
// keeps the exact composition it was tuned with.
const SOLC_0_8_27_SOURCES = [
  "contracts/v2/NoctisConfidentialToken.sol",
  "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol",
  "@openzeppelin/confidential-contracts/token/ERC7984/utils/ERC7984Utils.sol",
  "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol",
];

const solc0827 = {
  version: "0.8.27",
  settings: {
    optimizer: { enabled: true, runs: 1 },
    evmVersion: "cancun",
    viaIR: true,
  },
};

// FHEVM mock plugin — optional. Root monorepo may hoist @zama-fhe/relayer-sdk@0.4.x
// while the plugin expects 0.3.0-5. Use SKIP_FHEVM=1 for non-FHE unit tests / ops scripts.
if (process.env.SKIP_FHEVM !== "1") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("@fhevm/hardhat-plugin");
}

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1, // Minimum bytecode size for deployment (maximize size optimization)
          },
          evmVersion: "cancun",
          viaIR: true, // Enable IR-based code generation for better optimization
        },
      },
    ],
    overrides: Object.fromEntries(SOLC_0_8_27_SOURCES.map((s) => [s, solc0827])),
  },

  networks: {
    // Local development
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: true, // For testing large contracts
    },

    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    // ZAMA Devnet v0.9 (Native FHE Support)
    zamaDevnet: {
      url: process.env.ZAMA_DEVNET_RPC || "https://devnet.zama.ai",
      chainId: 8009,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: "auto",
    },

    // Ethereum Sepolia (Primary Testnet - FHEVM Supported)
    sepolia: {
      url: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 5000000000, // 5 gwei
    },

    // Ethereum mainnet (Phase D — @fhevm/solidity >= 0.11.1 for real Zama addresses)
    mainnet: {
      url: process.env.MAINNET_RPC || "https://rpc.ankr.com/eth",
      chainId: 1,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: "auto",
    },

    // Arbitrum Sepolia (Testnet)
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: "auto",
    },

    // Arbitrum One (Mainnet)
    arbitrumOne: {
      url: process.env.ARBITRUM_ONE_RPC || "https://arb1.arbitrum.io/rpc",
      chainId: 42161,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: "auto",
    },
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    outputFile: process.env.GAS_REPORT_FILE || undefined,
    noColors: process.env.GAS_REPORT_FILE ? true : false,
  },

  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      arbitrumOne: process.env.ARBISCAN_API_KEY || "",
      arbitrumSepolia: process.env.ARBISCAN_API_KEY || "",
    },
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },

  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },

  mocha: {
    timeout: 40000,
  },
};

export default config;
