import { BN } from '../quoting/tick';
import type BigNumber from 'bignumber.js';

/**
 * Multi-currency double-entry ledger (exact decimals).
 * Invariant: inside every transaction, for every asset, Σ amount = 0.
 * Conversions go through `trading:<asset>` accounts, so each asset balances independently.
 *
 * Accounts:
 *   cash:<A>            tradable balance on the exchange      (never negative)
 *   treasury:<A>        protected profit, never traded        (never negative)
 *   withdrawing:<A>     treasury reserved for a withdrawal in flight (still on the exchange until settled)
 *   trading:<A>         conversion account for fills
 *   expense:fees:<A>    fees paid
 *   equity:capital:<A>  deposits (owner capital)
 *   external:<A>        withdrawn to the owner's wallet
 */
export interface Posting {
  account: string;
  asset: string;
  amount: string;
}

export interface LedgerTransaction {
  id: string;
  ts: number;
  kind: 'deposit' | 'fill' | 'treasury_split' | 'treasury_promotion' | 'withdrawal_reserve' | 'withdrawal_release' | 'withdrawal' | 'adjustment';
  ref?: string;
  memo?: string;
  postings: Posting[];
}

export class LedgerImbalanceError extends Error {
  override name = 'LedgerImbalanceError';
}
export class InsufficientFundsError extends Error {
  override name = 'InsufficientFundsError';
}

const NON_NEGATIVE = /^(cash|treasury|withdrawing):/;

export function assertBalanced(tx: LedgerTransaction): void {
  const sums = new Map<string, BigNumber>();
  for (const p of tx.postings) {
    if (!p.account || !p.asset) throw new LedgerImbalanceError(`tx ${tx.id}: empty account/asset`);
    sums.set(p.asset, (sums.get(p.asset) ?? new BN(0)).plus(p.amount));
  }
  for (const [asset, s] of sums) {
    if (!s.isZero()) throw new LedgerImbalanceError(`tx ${tx.id}: asset ${asset} sums to ${s.toFixed()}`);
  }
}

export interface FillSpec {
  side: 'BUY' | 'SELL';
  base: string;
  quote: string;
  price: BigNumber.Value;
  qty: BigNumber.Value;
  fee: BigNumber.Value;
  feeAsset: string;
}

export class Ledger {
  private readonly bal = new Map<string, BigNumber>();
  private readonly ids = new Set<string>();
  readonly transactions: LedgerTransaction[] = [];

  /** Posts a transaction atomically. Idempotent on tx.id (re-posting the same id is a no-op). */
  post(tx: LedgerTransaction): boolean {
    if (this.ids.has(tx.id)) return false;
    assertBalanced(tx);
    const next = new Map<string, BigNumber>();
    for (const p of tx.postings) {
      const key = `${p.account}|${p.asset}`;
      next.set(key, (next.get(key) ?? this.bal.get(key) ?? new BN(0)).plus(p.amount));
    }
    for (const [key, v] of next) {
      if (NON_NEGATIVE.test(key) && v.lt(0)) throw new InsufficientFundsError(`tx ${tx.id}: ${key} would be ${v.toFixed()}`);
    }
    for (const [key, v] of next) this.bal.set(key, v);
    this.ids.add(tx.id);
    this.transactions.push(tx);
    return true;
  }

  balance(account: string, asset: string): BigNumber {
    return this.bal.get(`${account}|${asset}`) ?? new BN(0);
  }

  balances(): Array<{ account: string; asset: string; amount: string }> {
    return [...this.bal.entries()].map(([k, v]) => {
      const [account, asset] = k.split('|') as [string, string];
      return { account, asset, amount: v.toFixed() };
    });
  }

  /** Sum over all accounts per asset — must always be zero (closed system). */
  totals(): Map<string, BigNumber> {
    const t = new Map<string, BigNumber>();
    for (const [k, v] of this.bal) {
      const asset = k.split('|')[1]!;
      t.set(asset, (t.get(asset) ?? new BN(0)).plus(v));
    }
    return t;
  }

  /** Mark-to-market value of exchange-held balances (cash + treasury + withdrawing) in the quote asset. */
  equity(quote: string, marks: Record<string, number>): number {
    let e = new BN(0);
    for (const [k, v] of this.bal) {
      const [account, asset] = k.split('|') as [string, string];
      if (!NON_NEGATIVE.test(account + ':')) continue;
      const mark = asset === quote ? 1 : marks[asset];
      if (mark === undefined) throw new RangeError(`no mark for ${asset}`);
      e = e.plus(v.times(mark));
    }
    return e.toNumber();
  }

  // ---------------- transaction builders ----------------

  static deposit(id: string, ts: number, asset: string, amount: BigNumber.Value): LedgerTransaction {
    const a = new BN(amount);
    return {
      id, ts, kind: 'deposit',
      postings: [
        { account: `cash:${asset}`, asset, amount: a.toFixed() },
        { account: `equity:capital:${asset}`, asset, amount: a.negated().toFixed() },
      ],
    };
  }

  static fill(id: string, ts: number, f: FillSpec, ref?: string): LedgerTransaction {
    const qty = new BN(f.qty);
    const notional = new BN(f.price).times(qty);
    const s = f.side === 'BUY' ? 1 : -1;
    const postings: Posting[] = [
      { account: `cash:${f.quote}`, asset: f.quote, amount: notional.times(-s).toFixed() },
      { account: `trading:${f.quote}`, asset: f.quote, amount: notional.times(s).toFixed() },
      { account: `cash:${f.base}`, asset: f.base, amount: qty.times(s).toFixed() },
      { account: `trading:${f.base}`, asset: f.base, amount: qty.times(-s).toFixed() },
    ];
    const fee = new BN(f.fee);
    if (!fee.isZero()) {
      postings.push(
        { account: `cash:${f.feeAsset}`, asset: f.feeAsset, amount: fee.negated().toFixed() },
        { account: `expense:fees:${f.feeAsset}`, asset: f.feeAsset, amount: fee.toFixed() },
      );
    }
    return { id, ts, kind: 'fill', ...(ref ? { ref } : {}), postings };
  }

  static transfer(
    id: string, ts: number, kind: 'treasury_split' | 'treasury_promotion' | 'withdrawal_reserve' | 'withdrawal_release',
    from: string, to: string, asset: string, amount: BigNumber.Value,
  ): LedgerTransaction {
    const a = new BN(amount);
    return {
      id, ts, kind,
      postings: [
        { account: `${from}:${asset}`, asset, amount: a.negated().toFixed() },
        { account: `${to}:${asset}`, asset, amount: a.toFixed() },
      ],
    };
  }

  /**
   * Money leaving the exchange: `gross` leaves `from` (the reserve of a withdrawal in flight, or the
   * treasury directly); the owner receives gross − fee.
   */
  static withdrawal(id: string, ts: number, asset: string, gross: BigNumber.Value, fee: BigNumber.Value, from: 'treasury' | 'withdrawing' = 'treasury'): LedgerTransaction {
    const g = new BN(gross);
    const f = new BN(fee);
    if (!g.gt(0) || f.lt(0)) throw new RangeError('withdrawal amounts must be gross > 0, fee ≥ 0');
    if (f.gt(g)) throw new RangeError('withdrawal fee exceeds gross amount');
    return {
      id, ts, kind: 'withdrawal',
      postings: [
        { account: `${from}:${asset}`, asset, amount: g.negated().toFixed() },
        { account: `external:${asset}`, asset, amount: g.minus(f).toFixed() },
        ...(f.isZero() ? [] : [{ account: `expense:fees:${asset}`, asset, amount: f.toFixed() }]),
      ],
    };
  }
}
