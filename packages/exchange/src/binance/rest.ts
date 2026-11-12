export const BINANCE_REST_BASE = 'https://api.binance.com';

export interface BinanceSpotSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}

/**
 * Binance public REST (market data only: Binance is the reference venue, never traded on).
 */
export class BinanceRest {
  constructor(private readonly opts: { base?: string; fetchImpl?: typeof fetch } = {}) {}

  private async get<T>(path: string): Promise<T> {
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.base ?? BINANCE_REST_BASE}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Binance GET ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  /** Spot symbols currently TRADING. */
  async tradingSymbols(): Promise<BinanceSpotSymbol[]> {
    const r = await this.get<{ symbols: BinanceSpotSymbol[] }>('/api/v3/exchangeInfo?symbolStatus=TRADING&permissions=SPOT');
    return r.symbols.map(({ symbol, baseAsset, quoteAsset }) => ({ symbol, baseAsset, quoteAsset }));
  }

  bookTickerAll(): Promise<Array<{ symbol: string; bidPrice: string; askPrice: string }>> {
    return this.get('/api/v3/ticker/bookTicker');
  }
}
