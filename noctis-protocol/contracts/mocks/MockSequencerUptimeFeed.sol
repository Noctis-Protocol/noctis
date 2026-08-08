// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/AggregatorV3Interface.sol";

/**
 * @title MockSequencerUptimeFeed
 * @notice Mock Chainlink L2 Sequencer Uptime Feed for testing
 * @dev Simulates Arbitrum sequencer status monitoring (CRITICAL-1 fix testing)
 * 
 * Sequencer Status:
 * - answer = 0: Sequencer is UP and running
 * - answer = 1: Sequencer is DOWN (L2 cannot process transactions)
 * 
 * The startedAt timestamp indicates when the current status began:
 * - If sequencer just came back up, startedAt is recent
 * - Grace period prevents using stale prices immediately after recovery
 */
contract MockSequencerUptimeFeed is AggregatorV3Interface {
    uint8 public constant decimals = 0; // Sequencer status is binary (0 or 1)
    string public description = "L2 Sequencer Uptime Status Feed";
    uint256 public constant version = 1;
    
    int256 private sequencerStatus; // 0 = up, 1 = down
    uint256 private statusStartedAt; // When current status began
    uint80 private currentRound;
    
    /**
     * @notice Initialize sequencer feed (default: UP for 2 hours already)
     * @dev Starts with sequencer UP and grace period already passed for testing
     */
    constructor() {
        sequencerStatus = 0; // Start with sequencer UP
        statusStartedAt = block.timestamp - 7200; // 2 hours ago (past grace period)
        currentRound = 1;
    }
    
    /**
     * @notice Set sequencer status DOWN
     * @dev Simulates L2 sequencer outage
     */
    function setSequencerDown() external {
        sequencerStatus = 1;
        statusStartedAt = block.timestamp;
        currentRound++;
    }
    
    /**
     * @notice Set sequencer status UP
     * @dev Simulates L2 sequencer recovery
     */
    function setSequencerUp() external {
        sequencerStatus = 0;
        statusStartedAt = block.timestamp;
        currentRound++;
    }
    
    /**
     * @notice Simulate time passing (for grace period testing)
     * @param timeInSeconds Number of seconds to advance
     */
    function advanceTime(uint256 timeInSeconds) external {
        statusStartedAt = block.timestamp - timeInSeconds;
    }
    
    /**
     * @notice Get latest round data
     * @return roundId Round ID
     * @return answer Sequencer status (0 = up, 1 = down)
     * @return startedAt Timestamp when current status began
     * @return updatedAt Timestamp when status was last updated
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
            sequencerStatus,
            statusStartedAt,
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
            sequencerStatus,
            statusStartedAt,
            block.timestamp,
            _roundId
        );
    }
}
