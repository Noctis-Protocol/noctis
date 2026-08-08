// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig, ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @dev Interface for Zama's ACL contract - allowForDecryption function
 * Used for direct batch operations when consecutive FHE.makePubliclyDecryptable calls fail
 */
interface IACLBatch {
    function allowForDecryption(bytes32[] memory handlesList) external;
}

/**
 * @title GatewayCaller
 * @notice Abstract base contract for ZAMA FHEVM v0.9 integration
 * @dev FHEVM v0.9 uses self-relaying pattern (NO Oracle dependency)
 * 
 * v0.9 Architecture:
 * 1. Contract calls FHE.makePubliclyDecryptable() to mark values as decryptable
 * 2. Off-chain client/keeper calls publicDecrypt() via relayer-sdk
 * 3. Client submits cleartext + proof to contract callback
 * 4. Contract verifies with FHE.checkSignatures()
 * 
 * Security:
 * - No need for onlyGateway modifier (Oracle is deprecated)
 * - Security comes from FHE.checkSignatures() verification
 * - Proof cryptographically guarantees cleartext authenticity
 */
abstract contract GatewayCaller is ZamaEthereumConfig {
    // ============================================
    // STATE VARIABLES (Legacy - kept for compatibility)
    // ============================================

    /// @notice Gateway address (legacy - v0.9 doesn't need this)
    /// @dev Kept for backwards compatibility with existing code
    address public gateway;

    // ============================================
    // CUSTOM ERRORS
    // ============================================

    error SenderNotAllowed();
    error InvalidSignatures();
    error InvalidGateway();

    // ============================================
    // GATEWAY MANAGEMENT (Legacy)
    // ============================================

    /**
     * @notice Set gateway address (legacy - v0.9 doesn't need this)
     * @dev Kept for backwards compatibility
     */
    function _setGateway(address _gateway) internal {
        gateway = _gateway;
    }

    /**
     * @notice Check if gateway is configured (legacy)
     */
    function isGatewayConfigured() public view returns (bool) {
        return gateway != address(0);
    }

    // ============================================
    // ACL HELPER FUNCTIONS (ZAMA Best Practices)
    // ============================================

    /**
     * @notice Grant transient permission to address (gas optimized)
     * @dev ZAMA Best Practice: Use for temporary access within transaction
     * @param ciphertext Encrypted value to grant access to
     * @param addr Address to grant permission
     */
    function _grantTransientAccess(euint128 ciphertext, address addr) internal {
        FHE.allowTransient(ciphertext, addr);
    }

    /**
     * @notice Grant permanent permission to address
     * @param ciphertext Encrypted value to grant access to
     * @param addr Address to grant permission
     */
    function _grantPermanentAccess(euint128 ciphertext, address addr) internal {
        FHE.allow(ciphertext, addr);
    }

    /**
     * @notice Grant permission to this contract (common pattern)
     * @param ciphertext Encrypted value to grant self-access
     */
    function _grantSelfAccess(euint128 ciphertext) internal {
        FHE.allowThis(ciphertext);
    }

    /**
     * @notice Verify caller has access to ciphertext
     * @param ciphertext Encrypted value to check access for
     */
    function _verifySenderAccess(euint128 ciphertext) internal view {
        if (!FHE.isSenderAllowed(ciphertext)) revert SenderNotAllowed();
    }

    // ============================================
    // v0.9 PUBLIC DECRYPTION HELPERS
    // ============================================

    /**
     * @notice Mark a euint128 value as publicly decryptable
     * @dev Step 1 of v0.9 self-relaying pattern
     * @param ciphertext The encrypted value to make publicly decryptable
     */
    function _makePubliclyDecryptable(euint128 ciphertext) internal {
        FHE.makePubliclyDecryptable(ciphertext);
    }

    /**
     * @notice Mark an eaddress value as publicly decryptable
     * @param ciphertext The encrypted address to make publicly decryptable
     */
    function _makePubliclyDecryptableAddress(eaddress ciphertext) internal {
        FHE.makePubliclyDecryptable(ciphertext);
    }

    /**
     * @notice Mark multiple euint128 values as publicly decryptable in a single ACL call
     * @dev Workaround for Zama ACL bug where consecutive makePubliclyDecryptable calls 
     *      fail to properly register the second handle. By batching handles into a single
     *      allowForDecryption call, we ensure all handles are properly registered.
     * 
     * @param ciphertext1 First encrypted value to make publicly decryptable
     * @param ciphertext2 Second encrypted value to make publicly decryptable
     */
    function _makePubliclyDecryptableBatch(euint128 ciphertext1, euint128 ciphertext2) internal {
        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(ciphertext1);
        handles[1] = FHE.toBytes32(ciphertext2);
        
        // Direct call to ACL with both handles in single transaction
        // This bypasses the single-handle limitation in FHE.makePubliclyDecryptable
        IACLBatch(_getACLAddress()).allowForDecryption(handles);
    }

    /**
     * @notice Mark euint128 amount and ebool as publicly decryptable in a single ACL call
     * @dev PRIVACY FIX: Used for withdrawal verification where we decrypt:
     *      - encryptedAmount (euint128): The withdrawal amount requested
     *      - hasSufficientBalance (ebool): Whether user has enough balance (true/false only!)
     *      This preserves privacy by NOT revealing the actual balance, only a boolean.
     * 
     * @param amount The encrypted amount to make publicly decryptable
     * @param hasBalance The encrypted boolean (balance >= amount) to make publicly decryptable
     */
    function _makePubliclyDecryptableBatchAmountBool(euint128 amount, ebool hasBalance) internal {
        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(amount);
        handles[1] = FHE.toBytes32(hasBalance);
        
        // Direct call to ACL with both handles in single transaction
        IACLBatch(_getACLAddress()).allowForDecryption(handles);
    }

    /**
     * @notice Mark a single euint128 as publicly decryptable via direct ACL call
     * @dev WORKAROUND: FHE.makePubliclyDecryptable() may have issues on some networks.
     *      Using direct ACL call ensures consistent behavior with batch operations.
     * 
     * @param amount The encrypted amount to make publicly decryptable
     */
    function _makePubliclyDecryptableSingle(euint128 amount) internal {
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(amount);
        
        // Direct call to ACL - same approach as batch operations
        IACLBatch(_getACLAddress()).allowForDecryption(handles);
    }

    /**
     * @notice Get the ACL contract address from coprocessor config
     * @dev Internal helper for direct ACL access
     *      Dynamically gets the correct address based on current chain
     */
    function _getACLAddress() internal view returns (address) {
        // ACL for current chain (Sepolia / mainnet / local). Needs @fhevm/solidity >= 0.11.1 for mainnet.
        return ZamaConfig.getEthereumCoprocessorConfig().ACLAddress;
    }

    /**
     * @notice Verify decryption proof (v0.9 pattern)
     * @dev Step 3 of v0.9 self-relaying pattern
     *      Reverts if proof is invalid
     * @param handlesList Array of ciphertext handles (bytes32)
     * @param abiEncodedCleartexts ABI-encoded cleartext values
     * @param decryptionProof Proof from relayer-sdk publicDecrypt()
     */
    function _verifyDecryptionProof(
        bytes32[] memory handlesList,
        bytes memory abiEncodedCleartexts,
        bytes memory decryptionProof
    ) internal {
        FHE.checkSignatures(handlesList, abiEncodedCleartexts, decryptionProof);
    }

    // ============================================
    // CONVERSION HELPERS
    // ============================================

    /**
     * @notice Convert euint128 to bytes32 for handles array
     * @param ciphertext Encrypted value to convert
     * @return bytes32 handle
     */
    function _toBytes32(euint128 ciphertext) internal pure returns (bytes32) {
        return FHE.toBytes32(ciphertext);
    }

    /**
     * @notice Convert eaddress to bytes32 for handles array
     * @param ciphertext Encrypted address to convert
     * @return bytes32 handle
     */
    function _addressToBytes32(eaddress ciphertext) internal pure returns (bytes32) {
        return FHE.toBytes32(ciphertext);
    }
}
