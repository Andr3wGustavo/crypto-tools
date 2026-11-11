import { ResilientWs } from '../ws/resilient-ws';
import { systemClock, type Clock, type MarketDataHandlers, type MarketStream } from '../types';

/** Binance spot public market data — used only as the lead price reference (never for trading). */
export const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/stream';

interface BinanceBookTicker {
  u: number;
  s: string;
  b: string;
  B: string;
  a: string;
  A: string;
}

type BinanceCombined = { stream?: string; data?: BinanceBookTicker };

export function mapBinanceCombined(raw: string, ts: number, h: MarketDataHandlers): void {
  mapBinanceMessage(JSON.parse(raw) as BinanceCombined, ts, h);
}

function mapBinanceMessage(msg: BinanceCombined, ts: number, h: MarketDataHandlers): void {
  const d = msg.data;
  if (!d || !msg.stream?.endsWith('@bookTicker')) return;
  const bid = Number(d.b);
  const ask = Number(d.a);
  if (!(bid > 0 && ask > 0 && bid < ask)) return;
  h.onBook?.({ venue: 'binance', symbol: d.s, ts, bid, bidQty: Number(d.B), ask, askQty: Number(d.A) });
}

export class BinanceMarketStream implements MarketStream {
  private readonly ws: ResilientWs;

  constructor(symbols: string[], private readonly h: MarketDataHandlers, opts: { base?: string; clock?: Clock } = {}) {
    const clock = opts.clock ?? systemClock;
    const streams = symbols.map((s) => `${s.toLowerCase()}@bookTicker`).join('/');
    this.ws = new ResilientWs({
      name: 'binance',
      url: `${opts.base ?? BINANCE_WS_BASE}?streams=${streams}`,
      clock,
      pingIntervalMs: 30_000,
      staleMs: 15_000,
      maxLifetimeMs: 23 * 3600_000, // Binance disconnects at 24 h
      onState: (state, detail) => this.h.onStatus?.({ venue: 'binance', state, ...(detail ? { detail } : {}) }),
      onOpen: () => undefined,
      onMessage: (data) => {
        let msg: BinanceCombined;
        try {
          msg = JSON.parse(data.toString()) as BinanceCombined;
        } catch (err) {
          this.h.onStatus?.({ venue: 'binance', state: 'error', detail: `parse: ${(err as Error).message}` });
          return;
        }
        // Outside the try: an exception thrown by a handler (the trading loop) must propagate and
        // fail closed — never be mistaken for a bad message and swallowed.
        mapBinanceMessage(msg, clock(), this.h);
      },
    });
  }

  start(): void {
    this.ws.start();
  }
  stop(): void {
    this.ws.stop();
  }
  lastMessageAgeMs(now?: number): number {
    return this.ws.lastMessageAgeMs(now);
  }
}
