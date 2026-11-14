import type { BotEvent, SeriesPoint, StoredEvent } from '@cortex/shared';
import {
  AreaSeries, ColorType, CrosshairMode, LineSeries, LineStyle, createChart, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef } from 'react';
import { fmtPrice, fmtTime } from '../lib/format';

const C = { bg: 'transparent', grid: 'rgba(139,163,154,0.07)', text: '#8ba39a', line: '#142a31', brand: '#FFD60A', up: '#1FE07A', down: '#FF5468', ref: '#5d7972', fair: '#dfe8e3' };
const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
const hhmm = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });

function baseChart(el: HTMLElement, height: number): IChartApi {
  return createChart(el, {
    height,
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: C.bg }, textColor: C.text, fontFamily: 'JetBrains Mono Variable, monospace', fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.line },
    timeScale: { borderColor: C.line, timeVisible: true, secondsVisible: false, tickMarkFormatter: (t: Time) => hhmm.format((t as number) * 1000) },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { color: 'rgba(255,214,10,0.35)', labelBackgroundColor: '#0d2129' }, horzLine: { color: 'rgba(255,214,10,0.35)', labelBackgroundColor: '#0d2129' } },
    localization: { timeFormatter: (t: Time) => fmtTime((t as number) * 1000), priceFormatter: (p: number) => fmtPrice(p) },
    handleScale: { axisPressedMouseMove: { time: true, price: false } },
  });
}

type Line = { key: keyof SeriesPoint; color: string; width: 1 | 2 | 3; style?: LineStyle; title: string };
const PRICE_LINES: Line[] = [
  { key: 'quoteAsk', color: C.down, width: 1, style: LineStyle.Dotted, title: 'ask' },
  { key: 'quoteBid', color: C.up, width: 1, style: LineStyle.Dotted, title: 'bid' },
  { key: 'refMid', color: C.ref, width: 1, style: LineStyle.Dashed, title: 'Binance' },
  { key: 'fair', color: C.fair, width: 1, title: 'justo' },
  { key: 'mid', color: C.brand, width: 2, title: 'MEXC' },
];

/** Live price: MEXC mid, Binance reference, fair value, our quote band and the fills. */
/** Most recent fills drawn on the price chart. */
const MAX_FILL_MARKERS = 300;

export function PriceChart({ points, fills, height = 320 }: { points: SeriesPoint[]; fills: StoredEvent[]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const markers = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!el.current) return;
    const c = baseChart(el.current, height);
    chart.current = c;
    for (const l of PRICE_LINES) {
      series.current.set(l.key, c.addSeries(LineSeries, { color: l.color, lineWidth: l.width, lineStyle: l.style ?? LineStyle.Solid, title: l.title, priceLineVisible: l.key === 'mid', lastValueVisible: l.key === 'mid', crosshairMarkerVisible: l.key === 'mid' }));
    }
    markers.current = createSeriesMarkers(series.current.get('mid')!, []);
    return () => {
      c.remove();
      chart.current = null;
      series.current.clear();
      fitted.current = false;
    };
  }, [height]);

  useEffect(() => {
    for (const l of PRICE_LINES) {
      const s = series.current.get(l.key);
      if (!s) continue;
      // Our quotes come and go. The library joins points across whitespace, and a segment takes
      // the color of the point it STARTS from: the last point before a gap is made transparent so
      // no line bridges the minutes without an order.
      const gaps = l.key === 'quoteBid' || l.key === 'quoteAsk';
      const data: Array<{ time: UTCTimestamp; value: number; color?: string }> = [];
      let last = -1;
      for (const p of points) {
        const v = p[l.key];
        const t = sec(p.ts);
        if (t <= last) continue;
        last = t;
        if (typeof v === 'number' && v > 0) data.push({ time: t, value: v });
        else if (gaps && data.length > 0) data[data.length - 1]!.color = 'rgba(0,0,0,0)';
      }
      // The final point starts no segment; keeping its color keeps the axis label readable.
      if (data.length > 0) delete data[data.length - 1]!.color;
      s.setData(data);
    }
    if (!fitted.current && points.length > 1) {
      chart.current?.timeScale().fitContent();
      fitted.current = true;
    }
  }, [points]);

  const fillMarkers = useMemo(() => {
    const first = points[0]?.ts ?? Number.POSITIVE_INFINITY;
    const ms: Array<SeriesMarker<Time>> = [];
    for (const f of fills) {
      const e = f.e as Extract<BotEvent, { k: 'fill' }>;
      if (e.k !== 'fill' || e.ts < first) continue;
      // A dot at the exact fill price (no text): hundreds of fills stay readable.
      ms.push({ time: sec(e.ts), position: 'atPriceMiddle', price: e.price, shape: 'circle', color: e.side === 'BUY' ? C.up : C.down, size: 0.5 });
    }
    return ms.sort((a, b) => (a.time as number) - (b.time as number)).slice(-MAX_FILL_MARKERS);
  }, [fills, points]);

  useEffect(() => {
    markers.current?.setMarkers(fillMarkers);
  }, [fillMarkers]);

  return <div ref={el} className="w-full" style={{ height }} />;
}

/** Equity (US$) over time, as an area. */
export function EquityChart({ points, height = 200 }: { points: SeriesPoint[]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const s = useRef<ISeriesApi<'Area'> | null>(null);
  const c = useRef<IChartApi | null>(null);
  useEffect(() => {
    if (!el.current) return;
    const chart = baseChart(el.current, height);
    c.current = chart;
    s.current = chart.addSeries(AreaSeries, {
      lineColor: C.brand, lineWidth: 2, topColor: 'rgba(255,214,10,0.28)', bottomColor: 'rgba(255,214,10,0.0)',
      priceFormat: { type: 'custom', formatter: (p: number) => p.toFixed(4) },
    });
    return () => chart.remove();
  }, [height]);
  useEffect(() => {
    const data: Array<{ time: UTCTimestamp; value: number }> = [];
    let last = -1;
    for (const p of points) {
      const t = sec(p.ts);
      if (p.equity !== null && t > last) {
        data.push({ time: t, value: p.equity });
        last = t;
      }
    }
    s.current?.setData(data);
    c.current?.timeScale().fitContent();
  }, [points]);
  return <div ref={el} className="w-full" style={{ height }} />;
}

/** Tiny SVG trend line (no axes): card sparklines. */
export function Sparkline({ values, width = 120, height = 36, className }: { values: number[]; width?: number; height?: number; className?: string }) {
  if (values.length < 2) return <div style={{ width, height }} className={className} />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.abs(hi) * 1e-6 || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - ((v - lo) / span) * (height - 4)).toFixed(1)}`);
  const up = values[values.length - 1]! >= values[0]!;
  const color = up ? C.up : C.down;
  const id = `sg-${up ? 'u' : 'd'}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${pts.join(' ')} ${width},${height}`} fill={`url(#${id})`} />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Semicircle gauge for a probability, with an optional threshold tick (e.g. the GO bar). */
export function Gauge({ value, threshold, label, size = 132 }: { value: number; threshold?: number; label: string; size?: number }) {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const r = size / 2 - 10;
  const cx = size / 2;
  const cy = size / 2 + 2;
  const arc = (a: number) => [cx - r * Math.cos(a * Math.PI), cy - r * Math.sin(a * Math.PI)] as const;
  const [ex, ey] = arc(v);
  const color = v >= 0.95 ? C.up : v >= 0.5 ? C.brand : C.down;
  const tick = threshold !== undefined ? arc(threshold) : undefined;
  return (
    <figure className="flex flex-col items-center" aria-label={`${label}: ${(v * 100).toFixed(1)}%`}>
      <svg width={size} height={size / 2 + 14} viewBox={`0 0 ${size} ${size / 2 + 14}`}>
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="#142a31" strokeWidth="10" strokeLinecap="round" />
        {v > 0.001 && <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${ex} ${ey}`} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" />}
        {tick && <line x1={tick[0]} y1={tick[1]} x2={cx + (tick[0] - cx) * 1.18} y2={cy + (tick[1] - cy) * 1.18} stroke="#dfe8e3" strokeWidth="2" />}
        <text x={cx} y={cy - 6} textAnchor="middle" className="num" fill="#ffffff" fontSize="20" fontWeight="700">{(v * 100).toFixed(1)}%</text>
      </svg>
      <figcaption className="label -mt-1">{label}</figcaption>
    </figure>
  );
}
