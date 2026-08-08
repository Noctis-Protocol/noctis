// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../NoctisVault.sol";

/**
 * @title MockReentrantAttacker
 * @notice Mock contract to test reentrancy protection in NoctisVault
 * @dev Attempts to reenter depositUSDT function during token transfer callback
 */
contract MockReentrantAttacker {
    NoctisVault public vault;
    bool public attacking;
    uint256 public attackCount;

    constructor(address _vault) {
        vault = NoctisVault(payable(_vault));
    }

    /**
     * @notice Enable attack mode
     */
    function enableAttack() external {
        attacking = true;
        attackCount = 0;
    }

    /**
     * @notice Disable attack mode
     */
    function disableAttack() external {
        attacking = false;
        attackCount = 0;
    }

    /**
     * @notice Simulates a reentrancy attack
     * @dev Should be blocked by nonReentrant modifier
     */
    function attack() external {
        attacking = true;
        attackCount = 0;
        
        // Try to deposit, which should trigger callback and reentrancy attempt
        vault.depositUSDT(1e6); // 1 USDT
    }

    /**
     * @notice Attempt to claim ETH with reentrancy attack
     * @dev Should be blocked by nonReentrant modifier
     */
    function claimETHAttack() external {
        attacking = true;
        attackCount = 0;
        
        // Try to claim ETH, which should trigger receive() callback
        vault.claimETH();
    }

    /**
     * @notice Callback function that attempts reentrancy
     * @dev This would be called by a malicious ERC20/ERC777 token
     */
    function onTransfer() external {
        if (attacking && attackCount < 3) {
            attackCount++;
            // Attempt to reenter depositUSDT
            vault.depositUSDT(1e6);
        }
    }

    /**
     * @notice Receive function for ETH
     */
    receive() external payable {
        if (attacking && attackCount < 3) {
            attackCount++;
            // Attempt to reenter claimETH during claim
            vault.claimETH();
        }
    }
}

/**
 * @title MockMaliciousToken
 * @notice Mock ERC20 token with callback hook for testing reentrancy
 * @dev Calls back to sender during transferFrom to simulate ERC777-like behavior
 */
contract MockMaliciousToken {
    mapping(address => uint256) public balances;
    mapping(address => mapping(address => uint256)) public allowances;
    
    string public name = "Malicious Token";
    string public symbol = "EVIL";
    uint8 public decimals = 6;

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowances[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        require(allowances[from][msg.sender] >= amount, "Insufficient allowance");
        require(balances[from] >= amount, "Insufficient balance");

        allowances[from][msg.sender] -= amount;
        balances[from] -= amount;
        balances[to] += amount;

        // Malicious callback - try to reenter
        if (from.code.length > 0) {
            try MockReentrantAttacker(payable(from)).onTransfer() {} catch {}
        }

        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return allowances[owner][spender];
    }
}
