import type WebSocket from 'ws';
import { ResilientWs } from '../ws/resilient-ws';
import { systemClock, type Clock, type MarketDataHandlers, type MarketStream } from '../types';
import { decodeMexcPush, mexcChannels, type MexcPush } from './codec';

export const MEXC_WS_URL = 'wss://wbs-api.mexc.com/ws';
const MAX_SUBSCRIPTIONS = 30;

/** Pure mapping of a decoded push into book/trade ticks (unit-tested without a socket). */
export function mapMexcPush(p: MexcPush, ts: number, h: MarketDataHandlers): void {
  const symbol = p.symbol ?? p.channel.split('@').pop() ?? '';
  const bt = p.publicAggreBookTicker;
  if (bt) {
    const bid = Number(bt.bidPrice);
    const ask = Number(bt.askPrice);
    if (bid > 0 && ask > 0 && bid < ask) {
      h.onBook?.({ venue: 'mexc', symbol, ts, ...(p.sendTime ? { exchTs: p.sendTime } : {}), bid, bidQty: Number(bt.bidQuantity), ask, askQty: Number(bt.askQuantity) });
    }
  }
  for (const d of p.publicAggreDeals?.deals ?? []) {
    const price = Number(d.price);
    const qty = Number(d.quantity);
    if (!(price > 0 && qty > 0)) continue;
    h.onTrade?.({
      venue: 'mexc', symbol, ts, exchTs: d.time, ...(d.tradeId ? { tradeId: d.tradeId } : {}),
      price, qty, aggressor: d.tradeType === 1 ? 'buy' : 'sell',
    });
  }
}

export class MexcMarketStream implements MarketStream {
  private readonly ws: ResilientWs;

  constructor(
    symbols: string[],
    private readonly h: MarketDataHandlers,
    opts: { url?: string; interval?: '10ms' | '100ms'; clock?: Clock } = {},
  ) {
    const clock = opts.clock ?? systemClock;
    const channels = symbols.flatMap((s) => [mexcChannels.bookTicker(s, opts.interval), mexcChannels.deals(s, opts.interval)]);
    if (channels.length > MAX_SUBSCRIPTIONS) throw new RangeError(`MEXC allows ${MAX_SUBSCRIPTIONS} subscriptions per connection`);
    this.ws = new ResilientWs({
      name: 'mexc',
      url: opts.url ?? MEXC_WS_URL,
      clock,
      pingIntervalMs: 20_000,
      pingPayload: () => JSON.stringify({ method: 'PING' }),
      staleMs: 30_000,
      maxLifetimeMs: 23 * 3600_000, // MEXC closes connections at 24 h
      onState: (state, detail) => this.h.onStatus?.({ venue: 'mexc', state, ...(detail ? { detail } : {}) }),
      onOpen: (ws: WebSocket) => ws.send(JSON.stringify({ method: 'SUBSCRIPTION', params: channels })),
      onMessage: (data, isBinary) => {
        if (!isBinary) return; // JSON control frames: subscription acks / PONG
        let push: MexcPush;
        try {
          push = decodeMexcPush(data as Buffer);
        } catch (err) {
          this.h.onStatus?.({ venue: 'mexc', state: 'error', detail: `decode: ${(err as Error).message}` });
          return;
        }
        // Outside the try: an exception thrown by a handler (the trading loop) must propagate and
        // fail closed — never be mistaken for a bad frame and swallowed.
        mapMexcPush(push, clock(), this.h);
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
