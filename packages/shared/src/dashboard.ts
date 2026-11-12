import { z } from 'zod';
import { BotIdSchema } from './bot-id';

/**
 * Dashboard read contracts (v1). The worker publishes them to Redis, the API serves them over
 * REST and WebSocket, and the dashboard renders them.
 *
 * These are wire types on purpose: they are decoupled from the engine's internal types, so the
 * engine can change without breaking the UI. The worker maps engine outputs to them in one
 * place, apps/worker/src/ops/bot-view.ts.
 *
 * Numbers are plain JS numbers. Prices are display values; the ledger keeps the exact decimals.
 */

export const BotStatusSchema = z.enum(['running', 'paused', 'halted', 'killed']);
export type BotStatusName = z.infer<typeof BotStatusSchema>;
const SideSchema = z.enum(['BUY', 'SELL']);
const n = z.number();
const nn = z.number().nullable();

/** The latest state of one bot. Redis `bot:<id>:view`, refreshed at most once per second. */
export const BotViewSchema = z.object({
  v: z.literal(1),
  botId: BotIdSchema,
  venue: z.literal('mexc'),
  mode: z.enum(['shadow', 'live']),
  symbol: z.string(),
  base: z.string(),
  quote: z.string(),
  /** Experiment directory (`cfg-<hash12>`): one per pre-registered configuration. */
  run: z.string(),
  version: z.string(),
  startedAt: n,
  /** Time of the last processed input (the engine's clock). */
  ts: n,
  status: BotStatusSchema,
  quoting: z.boolean(),
  haltRule: z.string().nullable(),
  reduceOnly: z.boolean(),
  market: z.object({
    mid: nn,
    fair: nn,
    /** Binance mid, used only as the lead price. */
    refMid: nn,
    bestBid: nn,
    bestAsk: nn,
    /** Our working quotes (null = no order resting on that side). */
    quoteBid: nn,
    quoteAsk: nn,
    halfSpreadBps: nn,
    toxic: z.boolean(),
  }),
  balances: z.object({ quote: n, base: n }),
  pnl: z.object({ equity: nn, startEquity: nn, peakEquity: nn, realized: n, unrealized: n }),
  risk: z.object({ sigmaBps: n, adverseSelectionBps: n, markoutsObserved: n }),
  orders: z.array(z.object({ clientOrderId: z.string(), side: SideSchema, price: z.string(), qty: n, filled: n, status: z.string(), createdTs: n })),
  /**
   * Live NIG estimate of the hourly edge (bps of equity per hour). It is an uncorrected live
   * indicator only. The GO/NO-GO decision comes from the pre-registered protocol
   * (multiplicity- and autocorrelation-corrected), via the official evaluator.
   */
  edge: z.object({ n: n, meanBps: n, sdBps: n, pGo: n, pPositive: n, verdict: z.string() }),
  counters: z.object({ records: n, fills: n }),
  feeds: z.object({ mexcAgeMs: nn, binanceAgeMs: nn }),
  health: z.object({ errorsLastMin: n, eventLoopLagMs: n, clockSkewMs: n }),
});
export type BotView = z.infer<typeof BotViewSchema>;

/** One chart point. Redis stream `bot:<id>:series`, one point every SERIES_STEP_MS, 24 h kept. */
export const SeriesPointSchema = z.object({
  ts: n,
  mid: nn,
  fair: nn,
  refMid: nn,
  quoteBid: nn,
  quoteAsk: nn,
  equity: nn,
  inventory: n,
});
export type SeriesPoint = z.infer<typeof SeriesPointSchema>;
export const SERIES_STEP_MS = 5_000;
export const SERIES_MAX_POINTS = 17_280; // 24 h at 5 s

/** Notable things that happened. Redis stream `bot:<id>:events` (fills also in `bot:<id>:fills`). */
export const BotEventSchema = z.discriminatedUnion('k', [
  z.object({ k: z.literal('fill'), ts: n, fillId: z.string(), clientOrderId: z.string(), side: SideSchema, price: n, qty: n, fee: n, feeAsset: z.enum(['quote', 'base']) }),
  z.object({ k: z.literal('order'), ts: n, op: z.enum(['place', 'cancel']), clientOrderId: z.string(), side: SideSchema.optional(), price: z.string().optional(), qty: z.string().optional(), reason: z.string().optional() }),
  z.object({ k: z.literal('status'), ts: n, status: BotStatusSchema, quoting: z.boolean(), reason: z.string() }),
  z.object({ k: z.literal('risk'), ts: n, action: z.string(), violations: z.array(z.string()) }),
  z.object({ k: z.literal('error'), ts: n, message: z.string() }),
  z.object({ k: z.literal('edge'), ts: n, returnBps: n, n: n, pGo: n, pPositive: n, verdict: z.string() }),
  z.object({ k: z.literal('reconcile'), ts: n, ok: z.boolean(), diffs: n }),
  z.object({ k: z.literal('markout'), ts: n, fillId: z.string(), horizonMs: n, bps: n }),
  z.object({ k: z.literal('command'), ts: n, id: z.string().nullable(), command: z.string().nullable(), actor: z.string().nullable(), applied: z.boolean(), reason: z.string().optional() }),
]);
export type BotEvent = z.infer<typeof BotEventSchema>;
export type BotEventKind = BotEvent['k'];
export const EVENTS_MAX = 10_000;
export const FILLS_MAX = 50_000;

/** A stored event with its stream id (cursor for pagination). */
export interface StoredEvent {
  id: string;
  botId: string;
  e: BotEvent;
}

export const botKeys = (botId: string) => ({
  view: `bot:${botId}:view`,
  events: `bot:${botId}:events`,
  fills: `bot:${botId}:fills`,
  series: `bot:${botId}:series`,
  live: `bot:${botId}:live`,
});
/** Set of every bot id that ever published (the registry the API lists). */
export const BOTS_SET_KEY = 'bots';
/** Pub/sub pattern the API hub subscribes to. Messages carry a LiveMessage. */
export const LIVE_PATTERN = 'bot:*:live';

/** Published on `bot:<id>:live` by the worker (≤ 1 view/s, ≤ 1 point/step, every event). */
export type LiveMessage = { t: 'view'; view: BotView } | { t: 'point'; botId: string; p: SeriesPoint } | { t: 'event'; botId: string; id: string; e: BotEvent };

/**
 * WebSocket protocol (server → client; the client never sends data, commands go over REST):
 * `hello` on connect (and so on every reconnect: snapshot first), then `tick` batches at about
 * 4 Hz carrying only what changed.
 */
export type WsServerMessage =
  | { t: 'hello'; serverTime: number; actor: string; views: BotView[] }
  /** `eventsDropped` > 0: more events than one tick carries happened; refetch the lists over REST. */
  | { t: 'tick'; serverTime: number; views: BotView[]; points: Array<{ botId: string; p: SeriesPoint }>; events: StoredEvent[]; eventsDropped?: number }
  | { t: 'bye'; reason: 'session_expired' | 'slow_consumer' | 'shutdown' };
export const WS_TICK_MS = 250;
/** Close codes the client acts on (re-login vs reconnect). */
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_SLOW = 4408;

/** System view (API side): what the System page shows besides each bot's own health. */
export interface SystemInfo {
  serverTime: number;
  api: { version: string; uptimeS: number; wsClients: number; redis: boolean; rssMb: number };
  bots: Array<{ botId: string; ageMs: number; status: BotStatusName; version: string; run: string }>;
}

export interface AuditEntry {
  ts: number;
  actor: string;
  action: string;
  target: string | null;
  ip: string | null;
  data: Record<string, unknown> | null;
}
