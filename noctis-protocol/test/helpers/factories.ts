/**
 * TEST DATA FACTORIES
 * 
 * Factory functions to create common test data patterns.
 * Reduces boilerplate and improves test readability.
 * 
 * @see TEST_REFACTORING_GUIDE.md for usage examples
 */

import { Contract, Signer } from "ethers";
import { ethers } from "hardhat";
import { TEST_CONSTANTS } from "../constants";

/**
 * Create an ETH deposit
 * 
 * @param vault - NoctisVault contract
 * @param user - User making the deposit
 * @param amount - Amount to deposit (defaults to DEPOSIT_MEDIUM)
 * @returns Transaction receipt
 * 
 * @example
 * await createETHDeposit(vault, user1);
 * await createETHDeposit(vault, user2, TEST_CONSTANTS.ETH.DEPOSIT_LARGE);
 */
export async function createETHDeposit(
  vault: Contract,
  user: Signer,
  amount: bigint = TEST_CONSTANTS.ETH.DEPOSIT_MEDIUM
) {
  const tx = await vault.connect(user).depositETH({ value: amount });
  return await tx.wait();
}

/**
 * Create a USDT deposit
 * 
 * @param vault - NoctisVault contract
 * @param mockUsdt - MockERC20 USDT contract
 * @param user - User making the deposit
 * @param amount - Amount to deposit (defaults to DEPOSIT_MEDIUM)
 * @returns Transaction receipt
 * 
 * @example
 * await createUSDTDeposit(vault, mockUsdt, user1);
 * await createUSDTDeposit(vault, mockUsdt, user2, TEST_CONSTANTS.USDT.DEPOSIT_LARGE);
 */
export async function createUSDTDeposit(
  vault: Contract,
  mockUsdt: Contract,
  user: Signer,
  amount: bigint = TEST_CONSTANTS.USDT.DEPOSIT_MEDIUM
) {
  // Approve vault to spend USDT
  await mockUsdt.connect(user).approve(await vault.getAddress(), amount);
  
  // Deposit USDT
  const tx = await vault.connect(user).depositUSDT(amount);
  return await tx.wait();
}

/**
 * Create a withdrawal request
 * 
 * @param vault - NoctisVault contract
 * @param user - User requesting withdrawal
 * @param recipient - Recipient address
 * @param amount - Amount to withdraw
 * @param isEth - Whether it's ETH (true) or USDT (false)
 * @returns Transaction receipt and request ID
 * 
 * @example
 * const { receipt, requestId } = await createWithdrawalRequest(
 *   vault, user1, recipient.address, TEST_CONSTANTS.ETH.WITHDRAWAL_SMALL, true
 * );
 */
export async function createWithdrawalRequest(
  vault: Contract,
  user: Signer,
  recipient: string,
  amount: bigint,
  isEth: boolean = true
) {
  const tx = await vault.connect(user).requestEncryptedWithdrawal(
    recipient,
    amount,
    isEth
  );
  const receipt = await tx.wait();
  
  // Extract requestId from WithdrawalRequested event
  const event = receipt?.logs.find((log: any) => {
    try {
      const parsed = vault.interface.parseLog(log);
      return parsed?.name === "WithdrawalRequested";
    } catch {
      return false;
    }
  });
  
  const requestId = event ? vault.interface.parseLog(event)?.args.requestId : 1n;
  
  return { receipt, requestId };
}

/**
 * Setup Gateway with timelock
 * 
 * @param vault - NoctisVault contract
 * @param owner - Owner signer
 * @param gatewayAddress - Gateway address to set
 * 
 * @example
 * await setupGateway(vault, owner, mockGateway.getAddress());
 */
export async function setupGateway(
  vault: Contract,
  owner: Signer,
  gatewayAddress: string
) {
  await vault.connect(owner).proposeGateway(gatewayAddress);
  await ethers.provider.send("evm_increaseTime", [TEST_CONSTANTS.TIMELOCK.SKIP_GATEWAY]);
  await ethers.provider.send("evm_mine", []);
  await vault.connect(owner).executeGatewayChange();
}

/**
 * Setup Keeper with timelock
 * 
 * @param vault - NoctisVault contract
 * @param owner - Owner signer
 * @param keeperAddress - Keeper address to add
 * 
 * @example
 * await setupKeeper(vault, owner, keeper.address);
 */
export async function setupKeeper(
  vault: Contract,
  owner: Signer,
  keeperAddress: string
) {
  await vault.connect(owner).proposeAddKeeperV2(keeperAddress);
  const proposalId = (await vault.keeperProposalCounter()) - 1n;
  await ethers.provider.send("evm_increaseTime", [TEST_CONSTANTS.TIMELOCK.SKIP_KEEPER]);
  await ethers.provider.send("evm_mine", []);
  await vault.connect(owner).executeKeeperChangeV2(proposalId);
}

/**
 * Mint USDT to multiple users
 * 
 * @param mockUsdt - MockERC20 USDT contract
 * @param users - Array of user addresses
 * @param amount - Amount to mint per user (defaults to MINT_AMOUNT)
 * 
 * @example
 * await mintUSDT(mockUsdt, [user1.address, user2.address]);
 */
export async function mintUSDT(
  mockUsdt: Contract,
  users: string[],
  amount: bigint = TEST_CONSTANTS.USDT.MINT_AMOUNT
) {
  for (const user of users) {
    await mockUsdt.mint(user, amount);
  }
}

/**
 * Fund accounts with ETH
 * 
 * @param funder - Account funding the transfers (usually owner)
 * @param recipients - Array of recipient addresses
 * @param amount - Amount to send per recipient (defaults to INITIAL_BALANCE.ETH)
 * 
 * @example
 * await fundAccounts(owner, [user1.address, user2.address]);
 */
export async function fundAccounts(
  funder: Signer,
  recipients: string[],
  amount: bigint = TEST_CONSTANTS.INITIAL_BALANCE.ETH
) {
  for (const recipient of recipients) {
    await funder.sendTransaction({ to: recipient, value: amount });
  }
}

/**
 * Create a limit order
 * 
 * @param exchange - NoctisExchange contract
 * @param user - User creating the order
 * @param isBuy - Whether it's a buy order
 * @param amountETH - Amount of ETH
 * @param amountUSDT - Amount of USDT
 * @returns Transaction receipt and order ID
 * 
 * @example
 * const { receipt, orderId } = await createLimitOrder(
 *   exchange, user1, true, 
 *   TEST_CONSTANTS.ETH.DEPOSIT_SMALL,
 *   TEST_CONSTANTS.USDT.DEPOSIT_MEDIUM
 * );
 */
export async function createLimitOrder(
  exchange: Contract,
  user: Signer,
  isBuy: boolean,
  amountETH: bigint,
  amountUSDT: bigint
) {
  const tx = await exchange.connect(user).createLimitOrder(
    isBuy,
    amountETH,
    amountUSDT
  );
  const receipt = await tx.wait();
  
  // Extract orderId from OrderCreated event
  const event = receipt?.logs.find((log: any) => {
    try {
      const parsed = exchange.interface.parseLog(log);
      return parsed?.name === "OrderCreated";
    } catch {
      return false;
    }
  });
  
  const orderId = event ? exchange.interface.parseLog(event)?.args.orderId : 1n;
  
  return { receipt, orderId };
}

/**
 * Create a market order
 * 
 * @param exchange - NoctisExchange contract
 * @param user - User creating the order
 * @param isBuy - Whether it's a buy order
 * @param amountETH - Amount of ETH
 * @param maxSlippage - Maximum allowed slippage (basis points)
 * @returns Transaction receipt and order ID
 * 
 * @example
 * const { receipt, orderId } = await createMarketOrder(
 *   exchange, user1, true,
 *   TEST_CONSTANTS.ETH.DEPOSIT_SMALL,
 *   TEST_CONSTANTS.EXCHANGE.SLIPPAGE_TOLERANCE
 * );
 */
export async function createMarketOrder(
  exchange: Contract,
  user: Signer,
  isBuy: boolean,
  amountETH: bigint,
  maxSlippage: number = TEST_CONSTANTS.EXCHANGE.SLIPPAGE_TOLERANCE
) {
  const tx = await exchange.connect(user).createMarketOrder(
    isBuy,
    amountETH,
    maxSlippage
  );
  const receipt = await tx.wait();
  
  // Extract orderId from OrderCreated event
  const event = receipt?.logs.find((log: any) => {
    try {
      const parsed = exchange.interface.parseLog(log);
      return parsed?.name === "OrderCreated";
    } catch {
      return false;
    }
  });
  
  const orderId = event ? exchange.interface.parseLog(event)?.args.orderId : 1n;
  
  return { receipt, orderId };
}

/**
 * Skip time by a specific amount
 * 
 * @param seconds - Seconds to skip
 * 
 * @example
 * await skipTime(TEST_CONSTANTS.TIMELOCK.SKIP_GATEWAY);
 */
export async function skipTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}
