import { describe, expect, it } from "vitest";
import {
  Money,
  formatCurrency,
  formatExposure,
  formatPercent,
  formatSignedCurrency,
  fromDecimalString,
  sumMoney,
  toDecimalString,
} from "../../utils/money";

describe("money utils", () => {
  it("parses decimal strings into bigint cents", () => {
    const value = fromDecimalString("1234.56");
    expect(value).toBe(123456n);
  });

  it("formats currency with grouping and sign", () => {
    const positive: Money = 2500000n;
    const negative: Money = -4500n;
    expect(formatCurrency(positive)).toBe("$25,000.00");
    expect(formatSignedCurrency(negative)).toBe("-$45.00");
  });

  it("sums amounts without floating point drift", () => {
    const total = sumMoney([100n, 200n, 300n]);
    expect(total).toBe(600n);
  });

  it("converts bigint to decimal string", () => {
    expect(toDecimalString(7890123n)).toBe("78901.23");
  });

  it("formats percentages and exposure", () => {
    expect(formatPercent(12.345, 2)).toBe("12.35%");
    expect(formatExposure(1.2345, 2)).toBe("1.23x");
  });
});
