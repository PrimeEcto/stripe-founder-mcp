import type { MoneyValue } from "./types.js";

const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf"
]);

function getCurrencyFractionDigits(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
}

export function normalizeCurrency(currency: string | null | undefined): string {
  if (!currency) {
    return "usd";
  }

  return currency.toLowerCase();
}

export function formatMoney(amountCents: number, currency: string | null | undefined, locale = "en-US"): MoneyValue {
  const normalizedCurrency = normalizeCurrency(currency);
  const fractionDigits = getCurrencyFractionDigits(normalizedCurrency);
  const amount = fractionDigits === 0 ? amountCents : amountCents / 100;
  const formatter = new Intl.NumberFormat(locale, {
    currency: normalizedCurrency.toUpperCase(),
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
    style: "currency"
  });

  return {
    amount_cents: amountCents,
    currency: normalizedCurrency,
    formatted: formatter.format(amount)
  };
}
