/**
 * Simple PreciseDecimal implementation
 * Replaces the removed complex version from metaAdaptive
 */

// Use built-in math instead of decimal.js to avoid dependency issues
// For trading we use number with careful rounding

export class PreciseDecimal {
  private readonly value: number;

  constructor(value: string | number | PreciseDecimal) {
    if (value instanceof PreciseDecimal) {
      this.value = value.value;
    } else {
      this.value = typeof value === 'string' ? parseFloat(value) : value;
    }
  }

  static from(value: string | number | PreciseDecimal): PreciseDecimal {
    return new PreciseDecimal(value);
  }

  static fromRaw(value: number): PreciseDecimal {
    return new PreciseDecimal(value);
  }

  static zero(): PreciseDecimal {
    return new PreciseDecimal(0);
  }

  plus(other: string | number | PreciseDecimal): PreciseDecimal {
    const otherVal = other instanceof PreciseDecimal ? other.value : (typeof other === 'string' ? parseFloat(other) : other);
    return new PreciseDecimal(this.value + otherVal);
  }

  minus(other: string | number | PreciseDecimal): PreciseDecimal {
    const otherVal = other instanceof PreciseDecimal ? other.value : (typeof other === 'string' ? parseFloat(other) : other);
    return new PreciseDecimal(this.value - otherVal);
  }

  times(other: string | number | PreciseDecimal): PreciseDecimal {
    const otherVal = other instanceof PreciseDecimal ? other.value : (typeof other === 'string' ? parseFloat(other) : other);
    return new PreciseDecimal(this.value * otherVal);
  }

  dividedBy(other: string | number | PreciseDecimal): PreciseDecimal {
    const otherVal = other instanceof PreciseDecimal ? other.value : (typeof other === 'string' ? parseFloat(other) : other);
    return new PreciseDecimal(this.value / otherVal);
  }

  abs(): PreciseDecimal {
    return new PreciseDecimal(Math.abs(this.value));
  }

  negated(): PreciseDecimal {
    return new PreciseDecimal(-this.value);
  }

  isZero(): boolean {
    return this.value === 0;
  }

  isNegative(): boolean {
    return this.value < 0;
  }

  isPositive(): boolean {
    return this.value > 0;
  }

  lessThan(other: string | number | PreciseDecimal): boolean {
    const otherVal = other instanceof PreciseDecimal ? other.value : (typeof other === 'string' ? parseFloat(other) : other);
    return this.value < otherVal;
  }

  lessThanOrEqualTo(other: string | number | PreciseDecimal): boolean {
    const otherVal = other instanceof PreciseDecimal ? other.value : (typeof other === 'string' ? parseFloat(other) : other);
    return this.value <= otherVal;
  }

  greaterThan(other: string | number | PreciseDecimal): boolean {
    const otherVal = other instanceof PreciseDecimal ? other.value : (typeof other === 'string' ? parseFloat(other) : other);
    return this.value > otherVal;
  }

  greaterThanOrEqualTo(other: string | number | PreciseDecimal): boolean {
    const otherVal = other instanceof PreciseDecimal ? other.value : (typeof other === 'string' ? parseFloat(other) : other);
    return this.value >= otherVal;
  }

  equals(other: string | number | PreciseDecimal): boolean {
    const otherVal = other instanceof PreciseDecimal ? other.value : (typeof other === 'string' ? parseFloat(other) : other);
    return this.value === otherVal;
  }

  toNumber(): number {
    return this.value;
  }

  toString(): string {
    return String(this.value);
  }

  toFixed(dp?: number): string {
    return this.value.toFixed(dp);
  }

  get raw(): number {
    return this.value;
  }
}

export default PreciseDecimal;
