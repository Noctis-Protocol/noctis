/**
 * TEST FIXTURES
 * 
 * Centralized fixtures for deploying contracts in tests.
 * Uses Hardhat's loadFixture for snapshot/restore optimization (10-100x faster).
 */

import { ethers } from "hardhat";
import { TEST_CONSTANTS } from "../constants";

/**
 * Deploy NoctisVault with basic setup
 * 
 * Includes:
 * - MockERC20 (USDT)
 * - NoctisVault
 * - 4 test signers (owner, keeper, user1, user2)
 * 
 * @returns Deployed contracts and signers
 * 
 * @example
 * import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
 * 
 * const { vault, mockUsdt, owner, user1 } = await loadFixture(deployNoctisVaultFixture);
 */
export async function deployNoctisVaultFixture() {
  // Get signers
  const [owner, keeper, user1, user2, user3, user4] = await ethers.getSigners();

  // Deploy MockERC20 (USDT)
  const MockERC20Factory = await ethers.getContractFactory("MockERC20");
  const mockUsdt = await MockERC20Factory.deploy(
    "Tether USD",
    "USDT",
    TEST_CONSTANTS.USDT.DECIMALS
  );
  await mockUsdt.waitForDeployment();

  // Deploy NoctisVault
  const NoctisVaultFactory = await ethers.getContractFactory("NoctisVault");
  const vault = await NoctisVaultFactory.deploy(
    owner.address,
    await mockUsdt.getAddress()
  );
  await vault.waitForDeployment();

  // Mint USDT to test users
  await mockUsdt.mint(user1.address, TEST_CONSTANTS.USDT.MINT_AMOUNT);
  await mockUsdt.mint(user2.address, TEST_CONSTANTS.USDT.MINT_AMOUNT);
  await mockUsdt.mint(user3.address, TEST_CONSTANTS.USDT.MINT_AMOUNT);
  await mockUsdt.mint(user4.address, TEST_CONSTANTS.USDT.MINT_AMOUNT);

  return {
    vault,
    mockUsdt,
    owner,
    keeper,
    user1,
    user2,
    user3,
    user4,
  };
}

/**
 * Deploy NoctisVault with Keeper setup
 * 
 * Includes everything from deployNoctisVaultFixture plus:
 * - Keeper configured in Vault (with timelock executed)
 * 
 * @returns Deployed contracts and signers
 * 
 * @example
 * const { vault, keeper, user1 } = await loadFixture(deployVaultWithKeeperFixture);
 */
export async function deployVaultWithKeeperFixture() {
  const base = await deployNoctisVaultFixture();

  // Setup Keeper with timelock
  await base.vault.connect(base.owner).proposeAddKeeperV2(base.keeper.address);
  const proposalId = (await base.vault.keeperProposalCounter()) - 1n;
  await ethers.provider.send("evm_increaseTime", [TEST_CONSTANTS.TIMELOCK.SKIP_KEEPER]);
  await ethers.provider.send("evm_mine", []);
  await base.vault.connect(base.owner).executeKeeperChangeV2(proposalId);

  return base;
}

/**
 * Deploy minimal setup for unit tests
 * 
 * Just the bare minimum:
 * - MockERC20 (USDT)
 * - NoctisVault
 * - 2 signers (owner, user)
 * 
 * Use this for fast unit tests that don't need Gateway/Keeper
 * 
 * @example
 * const { vault, mockUsdt, owner, user } = await loadFixture(deployMinimalVaultFixture);
 */
export async function deployMinimalVaultFixture() {
  const [owner, user] = await ethers.getSigners();

  // Deploy MockERC20
  const MockERC20Factory = await ethers.getContractFactory("MockERC20");
  const mockUsdt = await MockERC20Factory.deploy(
    "Tether USD",
    "USDT",
    TEST_CONSTANTS.USDT.DECIMALS
  );
  await mockUsdt.waitForDeployment();

  // Deploy NoctisVault
  const NoctisVaultFactory = await ethers.getContractFactory("NoctisVault");
  const vault = await NoctisVaultFactory.deploy(owner.address, await mockUsdt.getAddress());
  await vault.waitForDeployment();

  // Mint USDT to user
  await mockUsdt.mint(user.address, TEST_CONSTANTS.USDT.MINT_AMOUNT);

  return {
    vault,
    mockUsdt,
    owner,
    user,
  };
}
