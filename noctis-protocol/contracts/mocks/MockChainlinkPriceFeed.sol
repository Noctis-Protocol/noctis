// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/AggregatorV3Interface.sol";

/**
 * @title MockChainlinkPriceFeed
 * @notice Mock Chainlink price feed for testing
 * @dev Simulates Chainlink ETH/USD price feed behavior
 */
contract MockChainlinkPriceFeed is AggregatorV3Interface {
    uint8 public constant decimals = 8; // Chainlink uses 8 decimals
    string public description = "ETH / USD";
    uint256 public constant version = 1;
    
    int256 private currentPrice;
    uint80 private currentRound;
    
    constructor(int256 initialPrice) {
        currentPrice = initialPrice;
        currentRound = 1;
    }
    
    /**
     * @notice Set price (for testing)
     * @param newPrice New price in 8 decimals (e.g., 300000000000 = $3000.00)
     */
    function setPrice(int256 newPrice) external {
        currentPrice = newPrice;
        currentRound++;
    }
    
    /**
     * @notice Get latest round data
     * @return roundId Round ID
     * @return answer Price with 8 decimals
     * @return startedAt Timestamp when round started
     * @return updatedAt Timestamp when round was updated
     * @return answeredInRound Round ID when answer was computed
     */
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (
            currentRound,
            currentPrice,
            block.timestamp,
            block.timestamp,
            currentRound
        );
    }
    
    /**
     * @notice Get round data by ID
     */
    function getRoundData(
        uint80 _roundId
    )
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (
            _roundId,
            currentPrice,
            block.timestamp,
            block.timestamp,
            _roundId
        );
    }
}
