// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockUniswapRouter
 * @notice Mock Uniswap Router for testing
 * @dev Simulates Uniswap V2 Router behavior without actual liquidity
 */
contract MockUniswapRouter {
    address public immutable WETH;
    
    event SwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint amountIn,
        uint amountOut
    );
    
    constructor(address _weth) {
        WETH = _weth;
    }
    
    function factory() external pure returns (address) {
        return address(0);
    }
    
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts) {
        require(deadline >= block.timestamp, "MockUniswapRouter: EXPIRED");
        require(path.length >= 2, "MockUniswapRouter: INVALID_PATH");
        
        // Simulate swap with 0.5% slippage
        uint amountOut = amountIn * 995 / 1000;
        require(amountOut >= amountOutMin, "MockUniswapRouter: INSUFFICIENT_OUTPUT_AMOUNT");
        
        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountOut;
        
        emit SwapExecuted(path[0], path[path.length - 1], amountIn, amountOut);
        
        return amounts;
    }
    
    function getAmountsOut(
        uint amountIn,
        address[] calldata path
    ) external pure returns (uint[] memory amounts) {
        require(path.length >= 2, "MockUniswapRouter: INVALID_PATH");
        
        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountIn * 995 / 1000; // 0.5% slippage
        
        return amounts;
    }
}
