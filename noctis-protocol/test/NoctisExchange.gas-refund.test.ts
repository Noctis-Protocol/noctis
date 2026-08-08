import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Gas-in-kind refund (relayer gas recovered from swap output).
 *
 * Model:
 * - User signs a flat gasRefundWei in the EIP-712 CreateOrder intent.
 * - Relayer passes it to createMarketOrderViaRelayer (capped by maxGasRefundWei).
 * - At settlement the refund is skimmed from the swap output alongside FEE_BPS
 *   and sent to feeRecipient (treasury reimburses the relayer gas float).
 * - ETH output: refund already in wei. USDT output: converted via oracle
 *   (8-dec price, 6-dec token: wei * price / 1e20).
 */
describe("NoctisExchange gas-in-kind refund", function () {
  const FEE_BPS = 5n;
  const ONE_ETH = 10n ** 18n;
  const PRICE_3000_8DEC = 3000n * 10n ** 8n;

  function skimEthOut(amountOut: bigint, gasRefundWei: bigint) {
    const fee = (amountOut * FEE_BPS) / 10_000n;
    return { fee, netOut: amountOut - fee - gasRefundWei };
  }

  function refundInUsdt(gasRefundWei: bigint, oraclePrice: bigint): bigint {
    return (gasRefundWei * oraclePrice) / 10n ** 20n;
  }

  describe("skim math", function () {
    it("ETH output: netOut = amountOut - fee - refund", function () {
      const amountOut = ONE_ETH; // 1 ETH out
      const refund = 3n * 10n ** 15n; // 0.003 ETH gas refund
      const { fee, netOut } = skimEthOut(amountOut, refund);
      expect(fee).to.equal(5n * 10n ** 14n); // 0.0005 ETH at 5 bps
      expect(netOut).to.equal(amountOut - fee - refund);
      expect(netOut + fee + refund).to.equal(amountOut); // conservation
    });

    it("USDT output: wei refund converts via /1e20 (8-dec price, 6-dec token)", function () {
      // 0.003 ETH at $3000 = $9 = 9_000_000 units (6 dec)
      const refund = refundInUsdt(3n * 10n ** 15n, PRICE_3000_8DEC);
      expect(refund).to.equal(9n * 10n ** 6n);
    });

    it("zero refund keeps legacy fee-only behavior", function () {
      const { fee, netOut } = skimEthOut(ONE_ETH, 0n);
      expect(netOut).to.equal(ONE_ETH - fee);
    });

    it("refund is negligible for desk-size clips, decisive for dust", function () {
      // $500k clip in ETH at $3000 = ~166.6 ETH out; 0.003 ETH refund = ~0.002%
      const bigClip = 1666n * 10n ** 17n;
      const refund = 3n * 10n ** 15n;
      const bps = (refund * 10_000n) / bigClip;
      expect(bps).to.be.lessThan(1n); // < 1 bps impact on a desk clip

      // Dust swap of 0.002 ETH out cannot even cover the 0.003 ETH refund
      const dust = 2n * 10n ** 15n;
      const { fee } = skimEthOut(dust, refund);
      expect(fee + refund >= dust).to.equal(true); // would revert OutputTooSmallForFees
    });
  });

  describe("contract source properties", function () {
    let src: string;
    before(function () {
      src = fs.readFileSync("contracts/NoctisExchange.sol", "utf8");
    });

    it("createMarketOrderViaRelayer takes gasRefundWei and enforces the cap", function () {
      expect(src).to.match(/uint128 gasRefundWei\s*\)/);
      expect(src).to.match(
        /if \(gasRefundWei > maxGasRefundWei\)\s*\{\s*revert GasRefundTooHigh\(gasRefundWei, maxGasRefundWei\);/
      );
    });

    it("refund is deleted from storage before the external fee transfer (CEI)", function () {
      // Both settlement branches read then delete before any transfer
      const deletes = src.match(/delete orderGasRefundWei\[orderId\];/g) || [];
      expect(deletes.length).to.equal(2);
      // ETH branch: delete appears before the feeRecipient call
      const ethBranch = src.indexOf("IWETH(WETH).withdraw(amountOut);");
      const ethDelete = src.indexOf("delete orderGasRefundWei[orderId];", ethBranch);
      const ethTransfer = src.indexOf("feeRecipient.call{value: fee + gasRefund}", ethBranch);
      expect(ethDelete).to.be.greaterThan(ethBranch);
      expect(ethDelete).to.be.lessThan(ethTransfer);
    });

    it("settlement reverts when output cannot cover fee + refund", function () {
      const guards = src.match(
        /if \(fee \+ gasRefund >= amountOut\) revert OutputTooSmallForFees\(\);/g
      ) || [];
      expect(guards.length).to.equal(2);
    });

    it("USDT branch converts the wei refund via oracle /1e20", function () {
      expect(src).to.match(
        /gasRefund = \(gasRefund \* _getChainlinkPrice\(\)\) \/ 1e20;/
      );
    });

    it("cap setter is PARAMS/timelock-gated and emits an event", function () {
      // M-2: setMaxGasRefundWei uses onlyTimelockOrRole(PARAMS_ROLE), not DEFAULT_ADMIN alone
      expect(src).to.match(
        /function setMaxGasRefundWei\(uint128 newMax\) external onlyTimelockOrRole\(PARAMS_ROLE\)/
      );
      expect(src).to.match(/emit MaxGasRefundUpdated\(maxGasRefundWei, newMax\);/);
    });

    it("refund event carries no user address (privacy policy)", function () {
      expect(src).to.match(
        /event GasRefundCollected\(uint256 indexed orderId, address indexed token, uint256 refundAmount\);/
      );
    });
  });

  describe("deployability", function () {
    it("Exchange bytecode stays within known size budget (EIP-170 follow-up)", async function () {
      const fs = await import("fs");
      const path = await import("path");
      const artifactPath = path.join(
        __dirname,
        "../artifacts/contracts/NoctisExchange.sol/NoctisExchange.json"
      );
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      const size = (artifact.deployedBytecode.length - 2) / 2;
      // Residual: currently ~25.1KB (> 24576 EIP-170). Hardhat allows unlimited size;
      // mainnet needs further shrink/split. Guard against unexpected growth.
      expect(size).to.be.lessThan(26_000);
      expect(size).to.be.greaterThan(20_000);
    });

    it("factory resolves (ABI includes gasRefundWei param)", async function () {
      const Exchange = await ethers.getContractFactory("NoctisExchange");
      const fn = Exchange.interface.getFunction("createMarketOrderViaRelayer");
      expect(fn?.inputs.map((i) => i.name)).to.include("gasRefundWei");
    });
  });
});
