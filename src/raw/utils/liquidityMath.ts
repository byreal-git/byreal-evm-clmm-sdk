import JSBI from '../jsbi.js'
import { NEGATIVE_ONE, ZERO } from '../internalConstants.js'

export abstract class LiquidityMath {
  /**
   * Cannot be constructed.
   */
  private constructor() {}

  public static addDelta(x: JSBI, y: JSBI): JSBI {
    if (JSBI.lessThan(y, ZERO)) {
      return JSBI.subtract(x, JSBI.multiply(y, NEGATIVE_ONE))
    } else {
      return JSBI.add(x, y)
    }
  }
}
