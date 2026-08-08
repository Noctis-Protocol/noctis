// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockUniswapRouterV2
 * @notice Uniswap V2 router mock with REAL token transfers and per-pair rates
 * @dev Unlike MockUniswapRouter (returns amounts without moving tokens), this mock
 *      pulls the input token and pays the output token, enabling full settlement
 *      E2E tests across pairs with different decimals. Fund it with output tokens
 *      and set a rate per hop: out = in * num / den.
 */
contract MockUniswapRouterV2 {
    address public immutable WETH;

    struct Rate {
        uint256 num;
        uint256 den;
    }

    /// @dev tokenIn => tokenOut => rate
    mapping(address => mapping(address => Rate)) public rates;

    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    constructor(address _weth) {
        WETH = _weth;
    }

    function factory() external pure returns (address) {
        return address(0);
    }

    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 den) external {
        require(den > 0, "MockUniswapRouterV2: ZERO_DEN");
        rates[tokenIn][tokenOut] = Rate(num, den);
    }

    function _quote(uint256 amountIn, address[] calldata path) internal view returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 1; i < path.length; i++) {
            Rate memory r = rates[path[i - 1]][path[i]];
            require(r.den > 0, "MockUniswapRouterV2: NO_RATE");
            amounts[i] = (amounts[i - 1] * r.num) / r.den;
        }
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "MockUniswapRouterV2: INVALID_PATH");
        return _quote(amountIn, path);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(deadline >= block.timestamp, "MockUniswapRouterV2: EXPIRED");
        require(path.length >= 2, "MockUniswapRouterV2: INVALID_PATH");

        amounts = _quote(amountIn, path);
        uint256 amountOut = amounts[amounts.length - 1];
        require(amountOut >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");

        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "MockUniswapRouterV2: PULL_FAILED");
        require(IERC20(path[path.length - 1]).transfer(to, amountOut), "MockUniswapRouterV2: PAY_FAILED");

        emit SwapExecuted(path[0], path[path.length - 1], amountIn, amountOut);
    }
}
