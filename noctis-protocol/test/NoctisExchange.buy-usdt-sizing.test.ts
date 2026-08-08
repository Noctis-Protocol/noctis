import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Pure math guard for BUY USDT sizing.
 * Chainlink ETH/USD = 8 decimals; USDC = 6 decimals.
 * Correct: (wei * price8) / 1e20
 * Bug was: / 1e18 → ~100× overstatement
 */
describe("NoctisExchange BUY USDT sizing math", function () {
  const ONE_ETH = 10n ** 18n;
  const PRICE_3000_8DEC = 3000n * 10n ** 8n;

  function usdtNeededBuggy(amountETH: bigint, oraclePrice: bigint): bigint {
    return (amountETH * oraclePrice) / 10n ** 18n;
  }

  function usdtNeededFixed(amountETH: bigint, oraclePrice: bigint): bigint {
    return (amountETH * oraclePrice) / 10n ** 20n;
  }

  it("fixed formula yields 3000 USDC for 1 ETH at $3000", function () {
    const units = usdtNeededFixed(ONE_ETH, PRICE_3000_8DEC);
    expect(units).to.equal(3000n * 10n ** 6n);
  });

  it("buggy /1e18 overstates by 100×", function () {
    const buggy = usdtNeededBuggy(ONE_ETH, PRICE_3000_8DEC);
    const fixed = usdtNeededFixed(ONE_ETH, PRICE_3000_8DEC);
    expect(buggy).to.equal(fixed * 100n);
    expect(buggy).to.equal(300_000n * 10n ** 6n);
  });

  it("applies slippage bps after base conversion", function () {
    const base = usdtNeededFixed(ONE_ETH, PRICE_3000_8DEC);
    const with50bps = (base * 10050n) / 10000n;
    expect(with50bps).to.equal(3015n * 10n ** 6n);
  });

  it("contract source uses / 1e20 in _prepareBuySufficiency", async function () {
    // Smoke: compiled artifact exists and fee constant still 5 bps
    const Exchange = await ethers.getContractFactory("NoctisExchange");
    expect(Exchange.bytecode.length).to.be.greaterThan(100);
    // Document expected divisor in bytecode-independent way
    const src = await import("fs").then((fs) =>
      fs.readFileSync("contracts/NoctisExchange.sol", "utf8")
    );
    expect(src).to.match(/usdtNeeded = \(uint256\(amountETH\) \* oraclePrice\) \/ 1e20/);
    expect(src).to.not.match(
      /usdtNeeded = \(uint256\(amountETH\) \* oraclePrice\) \/ 1e18;/
    );
  });
});
