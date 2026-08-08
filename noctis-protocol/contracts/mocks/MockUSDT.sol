// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockUSDT
 * @notice Mock USDT token for testing on Sepolia
 * @dev Standard ERC20 with mint function for testing
 */
contract MockUSDT is ERC20, Ownable {
    uint8 private _decimals;

    constructor() ERC20("Mock USDT", "USDT") Ownable(msg.sender) {
        _decimals = 6; // USDT uses 6 decimals
        
        // Mint initial supply to deployer (1M USDT for testing)
        _mint(msg.sender, 1_000_000 * 10**6);
    }

    /**
     * @notice Mint tokens to any address (testing only)
     * @param to Recipient address
     * @param amount Amount to mint (with 6 decimals)
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens from any address (testing only)
     * @param from Address to burn from
     * @param amount Amount to burn
     */
    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }

    /**
     * @notice Faucet function - anyone can mint 1000 USDT once per day
     * @dev For easy testing without owner interaction
     */
    mapping(address => uint256) public lastFaucetClaim;
    uint256 public constant FAUCET_AMOUNT = 1000 * 10**6; // 1000 USDT
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    function faucet() external {
        require(
            block.timestamp >= lastFaucetClaim[msg.sender] + FAUCET_COOLDOWN,
            "Faucet cooldown active"
        );
        
        lastFaucetClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        
        emit FaucetClaimed(msg.sender, FAUCET_AMOUNT);
    }

    event FaucetClaimed(address indexed user, uint256 amount);

    /**
     * @notice Override decimals to return 6 (like real USDT)
     */
    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }
}
