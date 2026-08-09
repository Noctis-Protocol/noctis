// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";

/**
 * @title NoctisConfidentialToken
 * @notice ERC-7984 confidential wrapper around a public ERC20 (e.g. USDC -> cUSDC)
 * @dev PRIVACY (confidential deposits): once wrapped, balances and transfer
 *      amounts are encrypted (euint64 handles). A user wraps once — the only
 *      public amount of their protocol lifetime — then deposits into the
 *      Noctis vault via confidentialTransferAndCall with an encrypted amount.
 *      This severs the deposit-amount <-> payout-amount correlation that
 *      plaintext deposits leak.
 *
 *      The wrapper is the audited OpenZeppelin implementation; this contract
 *      only binds it to the Zama Ethereum coprocessor config used by the rest
 *      of the protocol.
 */
contract NoctisConfidentialToken is ZamaEthereumConfig, ERC7984ERC20Wrapper {
    constructor(
        IERC20 underlying_,
        string memory name_,
        string memory symbol_,
        string memory contractURI_
    ) ERC7984(name_, symbol_, contractURI_) ERC7984ERC20Wrapper(underlying_) {}
}
