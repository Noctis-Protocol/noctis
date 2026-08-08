// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title NoctisTimelock
 * @notice Thin deployable wrapper around OpenZeppelin TimelockController.
 * @dev Used for Exchange non-emergency params (feeBps, size limits, gateway).
 *      Emergency pause stays on PAUSER_ROLE (Safe) and bypasses the delay.
 */
contract NoctisTimelock is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
