export type Money = bigint;

export const zeroMoney: Money = 0n;

const MONEY_MULTIPLIER = 100n;

const sanitizeDecimalString = (value: string) => value.replace(/[^0-9.-]/g, "");

export function fromDecimalString(input: string): Money | null {
  if (!input) {
    return null;
  }
  const normalized = sanitizeDecimalString(input);
  if (!normalized || normalized === "-" || normalized === "." || normalized === "-." || normalized === "-0" || normalized === "0-") {
    return null;
  }
  const negative = normalized.startsWith("-");
  const [integerPartRaw, fractionalPartRaw = ""] = normalized
    .replace(/^-/, "")
    .split(".");
  if (!/^\d*$/.test(integerPartRaw) || !/^\d*$/.test(fractionalPartRaw)) {
    return null;
  }
  const integerPart = integerPartRaw === "" ? "0" : integerPartRaw;
  const fractionalPart = (fractionalPartRaw + "00").slice(0, 2);
  const combined = BigInt(integerPart) * MONEY_MULTIPLIER + BigInt(fractionalPart);
  return negative ? -combined : combined;
}

export function toDecimalString(value: Money): string {
  const negative = value < 0;
  const absolute = negative ? -value : value;
  const dollars = absolute / MONEY_MULTIPLIER;
  const cents = Number(absolute % MONEY_MULTIPLIER);
  const centsString = cents.toString().padStart(2, "0");
  return `${negative ? "-" : ""}${dollars.toString()}.${centsString}`;
}

const withGrouping = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function formatCurrency(value: Money): string {
  const negative = value < 0;
  const absolute = negative ? -value : value;
  const dollars = absolute / MONEY_MULTIPLIER;
  const cents = Number(absolute % MONEY_MULTIPLIER);
  const centsString = cents.toString().padStart(2, "0");
  const base = withGrouping(dollars.toString());
  return `${negative ? "-" : ""}$${base}.${centsString}`;
}

export function formatSignedCurrency(value: Money): string {
  const formatted = formatCurrency(value);
  if (value > 0) {
    return `+${formatted}`;
  }
  return formatted;
}

export function sumMoney(values: Money[]): Money {
  return values.reduce((acc, current) => acc + current, zeroMoney);
}

export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

export function formatExposure(value: number, digits = 2): string {
  return `${value.toFixed(digits)}x`;
}
