// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IWETH
 * @notice Interface for Wrapped ETH (WETH)
 * @dev WETH is ERC20-wrapped ETH that can be traded on DEXs
 * 
 * Key Functions:
 * - deposit: Convert ETH to WETH
 * - withdraw: Convert WETH back to ETH
 * - approve: Approve spending (standard ERC20)
 * - transfer: Transfer WETH (standard ERC20)
 * 
 * Security:
 * - Always check balanceOf before operations
 * - Approve exact amounts (not infinite)
 * - Use SafeERC20 wrapper for extra safety
 */
interface IWETH {
    /**
     * @notice Deposit ETH and receive WETH
     * @dev msg.value ETH is wrapped into WETH
     */
    function deposit() external payable;
    
    /**
     * @notice Withdraw ETH by burning WETH
     * @param amount Amount of WETH to burn
     */
    function withdraw(uint256 amount) external;
    
    /**
     * @notice Approve spender to spend WETH
     * @param guy Spender address
     * @param wad Amount to approve
     * @return success True if approval succeeded
     */
    function approve(address guy, uint256 wad) external returns (bool success);
    
    /**
     * @notice Transfer WETH to another address
     * @param dst Destination address
     * @param wad Amount to transfer
     * @return success True if transfer succeeded
     */
    function transfer(address dst, uint256 wad) external returns (bool success);
    
    /**
     * @notice Get WETH balance of an address
     * @param owner Address to check
     * @return balance WETH balance
     */
    function balanceOf(address owner) external view returns (uint256 balance);
    
    /**
     * @notice Get total WETH supply
     * @return supply Total WETH in circulation
     */
    function totalSupply() external view returns (uint256 supply);
}
