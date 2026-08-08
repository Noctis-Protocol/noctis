// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Minimal Gateway interface for decryption requests
 * @dev Matches ZAMA Gateway v0.9 signature
 */
interface IGateway {
    function requestDecryption(
        uint256[] calldata ciphertexts,
        bytes4 callbackSelector,
        uint256 msgValue,
        uint256 maxTimestamp,
        bool passSignaturesToCaller
    ) external returns (uint256 requestId);
}
