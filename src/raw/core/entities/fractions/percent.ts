import JSBI from '../../../jsbi.js'
import { BigintIsh, Rounding } from '../../constants.js'
import { Fraction } from './fraction.js'

const ONE_HUNDRED = new Fraction(JSBI.BigInt(100))

/**
 * Converts a fraction to a percent
 * @param fraction the fraction to convert
 */
function toPercent(fraction: Fraction): Percent {
  return new Percent(fraction.numerator, fraction.denominator)
}

export class Percent extends Fraction {
  /**
   * This boolean prevents a fraction from being interpreted as a Percent
   */
  public readonly isPercent: true = true

  override add(other: Fraction | BigintIsh): Percent {
    return toPercent(super.add(other))
  }

  override subtract(other: Fraction | BigintIsh): Percent {
    return toPercent(super.subtract(other))
  }

  override multiply(other: Fraction | BigintIsh): Percent {
    return toPercent(super.multiply(other))
  }

  override divide(other: Fraction | BigintIsh): Percent {
    return toPercent(super.divide(other))
  }

  public override toSignificant(significantDigits: number = 5, format?: object, rounding?: Rounding): string {
    return super.multiply(ONE_HUNDRED).toSignificant(significantDigits, format, rounding)
  }

  public override toFixed(decimalPlaces: number = 2, format?: object, rounding?: Rounding): string {
    return super.multiply(ONE_HUNDRED).toFixed(decimalPlaces, format, rounding)
  }
}
