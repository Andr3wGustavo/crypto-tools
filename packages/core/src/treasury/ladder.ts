/** Capital ladder: D0 shadow → D1 $15 → D2 $50 → D3 $200+. Each step requires edge confirmed on the previous one. */
export interface LadderStage {
  stage: number;
  name: string;
  capital: number;
}

export const DEFAULT_LADDER: readonly LadderStage[] = [
  { stage: 0, name: 'D0 shadow', capital: 15 },
  { stage: 1, name: 'D1 live $15', capital: 15 },
  { stage: 2, name: 'D2 live $50', capital: 50 },
  { stage: 3, name: 'D3 live $200+', capital: 200 },
];

export function stageFor(capital: number, mode: 'shadow' | 'live', ladder = DEFAULT_LADDER): LadderStage {
  if (mode === 'shadow') return ladder[0]!;
  let current = ladder[1]!;
  for (const s of ladder) if (s.stage >= 1 && capital >= s.capital) current = s;
  return current;
}

export function nextStage(current: LadderStage, ladder = DEFAULT_LADDER): LadderStage | undefined {
  return ladder.find((s) => s.stage === current.stage + 1);
}

/** Can we quote both sides with at least one valid order each? cash ≥ 2·minOrder·(1 + buffer). */
export function viability(cashQuote: number, minOrderNotional: number, bufferPct = 0.1) {
  const required = 2 * minOrderNotional * (1 + bufferPct);
  return { canTrade: cashQuote >= required, required };
}

/** Days to grow from c0 to target at continuous net growth g per day: T = ln(target/c0)/g. */
export function daysToTarget(c0: number, target: number, gPerDay: number): number {
  if (!(c0 > 0) || !(target > 0)) throw new RangeError('capital must be > 0');
  if (target <= c0) return 0;
  return gPerDay > 0 ? Math.log(target / c0) / gPerDay : Number.POSITIVE_INFINITY;
}
