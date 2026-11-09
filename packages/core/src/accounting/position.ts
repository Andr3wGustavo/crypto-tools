/**
 * Average-cost inventory for realized/unrealized PnL in the quote asset (analytics layer;
 * the exact books live in Ledger). Long-only spot: selling more than held throws.
 */
export interface PositionFill {
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  fee: number;
  /** 'base' or 'quote' — which asset the fee was charged in. */
  feeIn: 'base' | 'quote';
}

export class OversellError extends Error {
  override name = 'OversellError';
}

const EPS = 1e-12;

export class AverageCostPosition {
  qty = 0;
  costBasis = 0;
  realizedPnl = 0;
  feesQuote = 0;

  onFill(f: PositionFill): number {
    const feeQuote = f.feeIn === 'quote' ? f.fee : f.fee * f.price;
    this.feesQuote += feeQuote;
    if (f.side === 'BUY') {
      const received = f.feeIn === 'base' ? f.qty - f.fee : f.qty;
      this.qty += received;
      this.costBasis += f.price * f.qty + (f.feeIn === 'quote' ? f.fee : 0);
      return 0;
    }
    if (f.qty > this.qty + EPS) throw new OversellError(`sell ${f.qty} > held ${this.qty}`);
    const avg = this.qty > 0 ? this.costBasis / this.qty : 0;
    const proceeds = f.price * f.qty - feeQuote;
    const realized = proceeds - avg * f.qty;
    this.costBasis -= avg * f.qty;
    this.qty -= f.qty;
    if (this.qty < EPS) {
      this.qty = 0;
      this.costBasis = 0;
    }
    this.realizedPnl += realized;
    return realized;
  }

  avgCost(): number {
    return this.qty > 0 ? this.costBasis / this.qty : 0;
  }

  unrealizedPnl(mark: number): number {
    return this.qty * mark - this.costBasis;
  }
}
