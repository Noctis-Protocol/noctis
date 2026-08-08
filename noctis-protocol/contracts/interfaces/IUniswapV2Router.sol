// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IUniswapV2Router02
 * @notice Interface for Uniswap V2 Router
 * @dev Used for executing swaps on Uniswap V2
 * 
 * Key Functions:
 * - swapExactTokensForTokens: Swap exact amount of input tokens for output tokens
 * - swapExactETHForTokens: Swap exact ETH for tokens
 * - swapExactTokensForETH: Swap exact tokens for ETH
 * - getAmountsOut: Get estimated output amounts for a swap
 * 
 * Security:
 * - Always use deadline parameter (prevent stale transactions)
 * - Always use amountOutMin parameter (slippage protection)
 * - Verify path[0] and path[path.length-1] are expected tokens
 */
interface IUniswapV2Router02 {
    /**
     * @notice Swap exact amount of tokens for another token
     * @param amountIn Amount of input tokens to swap
     * @param amountOutMin Minimum amount of output tokens (slippage protection)
     * @param path Array of token addresses (path[0] = input, path[n] = output)
     * @param to Recipient address
     * @param deadline Unix timestamp after which transaction reverts
     * @return amounts Array of amounts for each step in the path
     */
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
    
    /**
     * @notice Swap exact ETH for tokens
     * @param amountOutMin Minimum amount of output tokens (slippage protection)
     * @param path Array of token addresses (path[0] must be WETH)
     * @param to Recipient address
     * @param deadline Unix timestamp after which transaction reverts
     * @return amounts Array of amounts for each step in the path
     */
    function swapExactETHForTokens(
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external payable returns (uint[] memory amounts);
    
    /**
     * @notice Swap exact tokens for ETH
     * @param amountIn Amount of input tokens to swap
     * @param amountOutMin Minimum amount of ETH (slippage protection)
     * @param path Array of token addresses (path[n] must be WETH)
     * @param to Recipient address
     * @param deadline Unix timestamp after which transaction reverts
     * @return amounts Array of amounts for each step in the path
     */
    function swapExactTokensForETH(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
    
    /**
     * @notice Get estimated output amounts for a given input
     * @dev Does not account for slippage or price impact
     * @param amountIn Amount of input tokens
     * @param path Array of token addresses
     * @return amounts Estimated output amounts for each step
     */
    function getAmountsOut(
        uint amountIn,
        address[] calldata path
    ) external view returns (uint[] memory amounts);
    
    /**
     * @notice Get WETH address
     * @return WETH contract address
     */
    function WETH() external pure returns (address);
    
    /**
     * @notice Get factory address
     * @return Factory contract address
     */
    function factory() external pure returns (address);
}
