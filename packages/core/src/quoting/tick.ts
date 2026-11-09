import BigNumber from 'bignumber.js';

/** Private BigNumber flavour so we never depend on (or mutate) global config. */
export const BN = BigNumber.clone({
  DECIMAL_PLACES: 30,
  ROUNDING_MODE: BigNumber.ROUND_HALF_EVEN,
  EXPONENTIAL_AT: [-40, 40],
});
export type BNValue = BigNumber.Value;

/** Number of decimals implied by a step such as "0.0010" → 3. */
export function decimalsOf(step: string): number {
  const s = new BN(step).toFixed();
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

function toStep(value: BNValue, step: string, mode: BigNumber.RoundingMode): string {
  const st = new BN(step);
  if (!st.gt(0)) throw new RangeError(`step must be > 0, got ${step}`);
  const steps = new BN(value).div(st);
  // Snap binary-float noise (99.94999999999999 / 0.01 → 9994.999…) onto the exact multiple.
  const nearest = steps.integerValue(BigNumber.ROUND_HALF_EVEN);
  const snapped = steps.minus(nearest).abs().lt(1e-9) ? nearest : steps.integerValue(mode);
  return snapped.times(st).toFixed(decimalsOf(step));
}

export const floorToStep = (v: BNValue, step: string): string => toStep(v, step, BigNumber.ROUND_FLOOR);
export const ceilToStep = (v: BNValue, step: string): string => toStep(v, step, BigNumber.ROUND_CEIL);

export function addSteps(v: BNValue, step: string, n: number): string {
  return new BN(v).plus(new BN(step).times(n)).toFixed(decimalsOf(step));
}

export function notional(price: BNValue, qty: BNValue): string {
  return new BN(price).times(qty).toFixed();
}
