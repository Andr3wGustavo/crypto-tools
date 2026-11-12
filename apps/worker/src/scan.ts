import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SCANNER_PARAMS, bookGateReasons, bookStats, canonicalJson, quantile, rankPairs, screenUniverse, tradeStats,
  type BookSample, type PairMeasurement, type ScannerParams, type UniverseRow,
} from '@cortex/core';
import { BinanceRest, MexcRest, mexcSymbolInfo } from '@cortex/exchange';

/**
 * Pair scanner CLI (public data only, no keys).
 *
 *   npx tsx apps/worker/src/scan.ts [--minutes 10] [--every 5000] [--top 8] [--out data/scans]
 *
 * 1. Universe: MEXC exchangeInfo + 24h tickers + Binance spot listings → static gates.
 * 2. Book sampling: the whole-market MEXC bookTicker every `--every` ms for `--minutes`
 *    (one request per sample), plus the Binance book at 3 checkpoints (reference basis).
 * 3. Trades: the last 1000 public trades of every pair that passed the book gates.
 * 4. Rank and write a report whose `paramsHash` pre-registers the selection.
 */
export const SCANNER_VERSION = 1;

const arg = (name: string, d: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const argStr = (name: string, d: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? String(process.argv[i + 1]) : d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mid = (bid: string, ask: string) => (Number(bid) + Number(ask)) / 2;

async function main(): Promise<void> {
  const minutes = arg('minutes', 10);
  const everyMs = arg('every', 5_000);
  const params: ScannerParams = { ...DEFAULT_SCANNER_PARAMS, topN: arg('top', DEFAULT_SCANNER_PARAMS.topN) };
  const outDir = argStr('out', path.join('data', 'scans'));
  const paramsHash = crypto.createHash('sha256').update(canonicalJson({ v: SCANNER_VERSION, params, minutes, everyMs })).digest('hex');
  const startedAt = new Date().toISOString();
  console.log(`pair scanner v${SCANNER_VERSION} — ${minutes} min, sample every ${everyMs} ms, params ${paramsHash.slice(0, 12)}`);

  const mexc = new MexcRest();
  const binance = new BinanceRest();

  // ---- 1. universe
  const [raws, tickers, bnSymbols] = await Promise.all([mexc.exchangeInfoAll(), mexc.ticker24hAll(), binance.tradingSymbols()]);
  const refBases = new Set(bnSymbols.filter((s) => s.quoteAsset === params.quote).map((s) => s.baseAsset));
  const vol = new Map(tickers.map((t) => [t.symbol, Number(t.quoteVolume)]));
  const rows: UniverseRow[] = [];
  for (const raw of raws) {
    let info;
    try {
      info = mexcSymbolInfo(raw);
    } catch {
      continue; // malformed rules: not tradable for us
    }
    rows.push({
      symbol: info.symbol, base: info.base, quote: info.quote, tradable: info.tradable, flagged: raw.st === true,
      makerFeeRate: info.makerFeeRate, minNotional: info.rules.minNotional, tickSize: Number(info.rules.tickSize),
      quoteVolume24h: vol.get(info.symbol) ?? 0, hasReference: refBases.has(info.base),
    });
  }
  const universe = screenUniverse(rows, params);
  const reasonCounts: Record<string, number> = {};
  for (const r of universe.rejected) for (const why of r.reasons) {
    const key = why.replace(/[\d.]+/g, '#');
    reasonCounts[key] = (reasonCounts[key] ?? 0) + 1;
  }
  console.log(`universe: ${rows.length} symbols → ${universe.pass.length} pass static gates`);

  // ---- 2. book sampling
  const watch = new Map(universe.pass.map((r) => [r.symbol, r]));
  const samples = new Map<string, BookSample[]>([...watch.keys()].map((s) => [s, []]));
  const basis = new Map<string, number[]>();
  const iterations = Math.max(2, Math.round((minutes * 60_000) / everyMs));
  const checkpoints = new Set([0, Math.floor(iterations / 2), iterations - 1]);
  let failures = 0;
  for (let i = 0; i < iterations; i++) {
    const t0 = Date.now();
    try {
      const [book, ref] = await Promise.all([mexc.bookTickerAll(), checkpoints.has(i) ? binance.bookTickerAll() : Promise.resolve(undefined)]);
      const ts = Date.now();
      const refMid = ref && new Map(ref.map((b) => [b.symbol, mid(b.bidPrice, b.askPrice)]));
      for (const b of book) {
        const r = watch.get(b.symbol);
        if (!r) continue;
        samples.get(b.symbol)!.push({ ts, bid: Number(b.bidPrice), ask: Number(b.askPrice) });
        const rm = refMid?.get(`${r.base}${params.quote}`);
        const m = mid(b.bidPrice, b.askPrice);
        if (rm && rm > 0 && m > 0) basis.set(b.symbol, [...(basis.get(b.symbol) ?? []), Math.log(m / rm) * 1e4]);
      }
    } catch (err) {
      failures++;
      console.warn(`sample ${i} failed: ${(err as Error).message}`);
    }
    if ((i + 1) % 12 === 0) console.log(`  sampled ${i + 1}/${iterations}`);
    if (i < iterations - 1) await sleep(Math.max(0, everyMs - (Date.now() - t0)));
  }

  // ---- 3. trades for book-gate survivors
  const measurements: PairMeasurement[] = [];
  for (const [symbol, row] of watch) {
    const book = bookStats(samples.get(symbol)!, row.tickSize);
    const b = basis.get(symbol);
    const m: PairMeasurement = { row, book, referenceBasisBps: b?.length ? quantile([...b].sort((x, y) => x - y), 0.5) : undefined };
    if (bookGateReasons(book, params).length === 0) {
      try {
        const t = await mexc.trades(symbol);
        m.trades = tradeStats(t.map((x) => ({ time: x.time, price: Number(x.price), qty: Number(x.qty), isBuyerMaker: x.isBuyerMaker })));
      } catch (err) {
        console.warn(`trades ${symbol} failed: ${(err as Error).message}`);
      }
      await sleep(150);
    }
    measurements.push(m);
  }

  // ---- 4. rank + report
  const { ranked, selected } = rankPairs(measurements, params);
  const byMeasurement = new Map(measurements.map((m) => [m.row.symbol, m]));
  const fmt = (x: number | undefined, d = 2) => (x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
  console.log('\nrank symbol          score   hs(bps) spread(t) spread(bps) σ60(bps) trades/min basis(bps) vol24h(k)  verdict');
  ranked.slice(0, 40).forEach((s, i) => {
    const m = byMeasurement.get(s.symbol)!;
    console.log(
      `${String(i + 1).padStart(4)} ${s.symbol.padEnd(15)} ${fmt(s.score, 3).padStart(6)} ${fmt(s.hsBps).padStart(8)} ${String(m.book.spreadTicksP50).padStart(9)} ${fmt(m.book.spreadBpsP50, 1).padStart(11)} ${fmt(m.book.sigma60Bps).padStart(8)} ${fmt(m.trades?.perMin, 1).padStart(10)} ${fmt(m.referenceBasisBps, 0).padStart(10)} ${fmt(m.row.quoteVolume24h / 1e3, 0).padStart(9)}  ${s.eligible ? (selected.includes(s) ? 'SELECTED' : 'eligible') : s.reasons[0]}`,
    );
  });

  const report = {
    kind: 'pair-scan', version: SCANNER_VERSION, paramsHash, params, minutes, everyMs, startedAt, finishedAt: new Date().toISOString(),
    universe: { total: rows.length, passed: universe.pass.length, rejectedByReason: reasonCounts },
    sampling: { iterations, failures },
    selected: selected.map((s) => {
      const m = byMeasurement.get(s.symbol)!;
      return {
        symbol: s.symbol, reference: `${s.base}${params.quote}`, score: s.score, hsBps: s.hsBps,
        spreadTicksP50: m.book.spreadTicksP50, spreadBpsP50: m.book.spreadBpsP50, sigma60Bps: m.book.sigma60Bps,
        tradesPerMin: m.trades?.perMin, referenceBasisBps: m.referenceBasisBps, quoteVolume24h: m.row.quoteVolume24h,
      };
    }),
    ranked: ranked.map((s) => ({ ...s, measurement: byMeasurement.get(s.symbol) })),
  };
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `scan-${startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nselected ${selected.length}/${params.topN}: ${selected.map((s) => s.symbol).join(', ') || '(none)'}`);
  console.log(`sample failures: ${failures}/${iterations} · report: ${file}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
