// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint128, ebool, externalEuint128} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import "../NoctisVault.sol";

/**
 * @notice Minimal exchange mock for testing vault deduct auth / fund-safety
 */
contract MockExchangeCaller is ZamaEthereumConfig {
    NoctisVault public immutable vault;

    constructor(address payable vault_) {
        vault = NoctisVault(vault_);
    }

    function prepareEncrypted(
        uint256 orderId,
        address user,
        externalEuint128 inputHandle,
        bytes calldata inputProof,
        bool isEth
    ) external returns (bytes32) {
        euint128 enc = FHE.fromExternal(inputHandle, inputProof);
        FHE.allowThis(enc);
        return vault.prepareDeductAuthEncrypted(orderId, user, enc, isEth);
    }

    function preparePlain(
        uint256 orderId,
        address user,
        uint256 amount,
        bool isEth
    ) external returns (bytes32) {
        return vault.prepareDeductAuth(orderId, user, amount, isEth);
    }

    function deductWithProof(
        uint256 orderId,
        address user,
        uint256 amount,
        bool isEth,
        bytes calldata cleartexts,
        bytes calldata proof
    ) external {
        vault.deductBalanceWithProof(orderId, user, amount, isEth, cleartexts, proof);
    }

    function legacyDeduct(address user, uint256 amount, bool isEth) external {
        vault.deductBalance(user, amount, isEth);
    }

    receive() external payable {}
}
