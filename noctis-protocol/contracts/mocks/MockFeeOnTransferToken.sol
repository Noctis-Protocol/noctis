// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockFeeOnTransferToken
 * @notice Mock ERC20 with optional transfer fee to test fee-on-transfer vulnerability
 * @dev Simulates USDT's dormant fee-on-transfer mechanism
 */
contract MockFeeOnTransferToken {
    string public name;
    string public symbol;
    uint8 public decimals;
    
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    
    // Fee configuration
    uint256 public transferFeePercentage; // In basis points (100 = 1%)
    address public feeCollector;
    bool public feesEnabled;
    
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event FeeCollected(address indexed from, address indexed to, uint256 fee);
    event FeesToggled(bool enabled);
    event FeePercentageUpdated(uint256 newPercentage);
    
    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals
    ) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        feeCollector = msg.sender;
        feesEnabled = false; // Disabled by default (like real USDT)
        transferFeePercentage = 100; // 1% default
    }
    
    /**
     * @notice Mint tokens (for testing)
     */
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    
    /**
     * @notice Enable/disable transfer fees (simulates USDT governance)
     */
    function setFeesEnabled(bool _enabled) external {
        feesEnabled = _enabled;
        emit FeesToggled(_enabled);
    }
    
    /**
     * @notice Set fee percentage in basis points (100 = 1%)
     */
    function setFeePercentage(uint256 _percentage) external {
        require(_percentage <= 1000, "Fee too high"); // Max 10%
        transferFeePercentage = _percentage;
        emit FeePercentageUpdated(_percentage);
    }
    
    /**
     * @notice Set fee collector address
     */
    function setFeeCollector(address _collector) external {
        require(_collector != address(0), "Invalid collector");
        feeCollector = _collector;
    }
    
    /**
     * @notice Standard ERC20 approve
     */
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
    
    /**
     * @notice Standard ERC20 transfer with optional fee
     */
    function transfer(address to, uint256 amount) external returns (bool) {
        return _transferWithFee(msg.sender, to, amount);
    }
    
    /**
     * @notice Standard ERC20 transferFrom with optional fee
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "Insufficient allowance");
        
        allowance[from][msg.sender] = allowed - amount;
        
        return _transferWithFee(from, to, amount);
    }
    
    /**
     * @notice Internal transfer with optional fee deduction
     * @dev This is where the fee-on-transfer vulnerability comes from
     */
    function _transferWithFee(
        address from,
        address to,
        uint256 amount
    ) internal returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        
        uint256 amountAfterFee = amount;
        uint256 fee = 0;
        
        // Calculate fee if enabled
        if (feesEnabled && from != feeCollector && to != feeCollector) {
            fee = (amount * transferFeePercentage) / 10000;
            amountAfterFee = amount - fee;
            
            // Collect fee
            if (fee > 0) {
                balanceOf[feeCollector] += fee;
                emit FeeCollected(from, feeCollector, fee);
            }
        }
        
        // Transfer
        balanceOf[from] -= amount; // Deduct full amount from sender
        balanceOf[to] += amountAfterFee; // Credit only net amount to recipient
        
        emit Transfer(from, to, amountAfterFee);
        
        return true;
    }
}
