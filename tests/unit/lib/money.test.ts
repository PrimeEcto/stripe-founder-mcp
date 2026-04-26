import { formatMoney, normalizeCurrency } from "../../../src/lib/money.js";

describe("normalizeCurrency", () => {
  it("defaults missing values to usd", () => {
    expect(normalizeCurrency(undefined)).toBe("usd");
    expect(normalizeCurrency(null)).toBe("usd");
  });

  it("normalizes codes to lowercase", () => {
    expect(normalizeCurrency("USD")).toBe("usd");
  });
});

describe("formatMoney", () => {
  it("formats standard two-decimal currencies", () => {
    expect(formatMoney(12345, "usd")).toEqual({
      amount_cents: 12345,
      currency: "usd",
      formatted: "$123.45"
    });
  });

  it("formats zero-decimal currencies without dividing by 100", () => {
    expect(formatMoney(12345, "jpy")).toEqual({
      amount_cents: 12345,
      currency: "jpy",
      formatted: "¥12,345"
    });
  });

  it("formats negative amounts", () => {
    expect(formatMoney(-2500, "usd")).toEqual({
      amount_cents: -2500,
      currency: "usd",
      formatted: "-$25.00"
    });
  });
});
