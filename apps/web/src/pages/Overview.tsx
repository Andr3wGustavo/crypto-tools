import type { BotView } from '@cortex/shared';
import { Gauge, Sparkline } from '../components/charts';
import { Card, Empty, Link, Pill, Skeleton, Stat, StatusBadge, cx, toneOf } from '../components/ui';
import { aprOf, bandOf, botHealth, pnlOf, totalsOf, touchSpreadBps } from '../lib/derive';
import { fmtBps, fmtInt, fmtPct, fmtUsd, pairLabel } from '../lib/format';
import { hrefOf } from '../lib/router';
import { live, useLiveVersion, useSeries, useServerNow, useViews } from '../state';

/** Quote band, Revert-style "range": venue touch, our bid/ask band, fair value. */
export function BandBar({ v }: { v: BotView }) {
  const b = bandOf(v);
  const at = (x: number | null) => (x === null ? undefined : `${x}%`);
  return (
    <div>
      <div className="relative h-7 rounded-lg border border-line bg-bg/60" aria-label="Banda de cotação">
        {b.bestBid !== null && b.bestAsk !== null && (
          <div className="absolute inset-y-2 rounded bg-white/5" style={{ left: at(b.bestBid), width: `${b.bestAsk - b.bestBid}%` }} title="Book da MEXC (melhor compra → melhor venda)" />
        )}
        {b.quoteBid !== null && b.quoteAsk !== null && (
          <div className="absolute inset-y-1 rounded-md border border-brand/50 bg-brand/15" style={{ left: at(b.quoteBid), width: `${b.quoteAsk - b.quoteBid}%` }} title="Nossa banda (bid → ask)" />
        )}
        {b.quoteBid !== null && <div className="absolute inset-y-0.5 w-0.5 rounded bg-up" style={{ left: at(b.quoteBid) }} title="Nossa compra" />}
        {b.quoteAsk !== null && <div className="absolute inset-y-0.5 w-0.5 rounded bg-down" style={{ left: at(b.quoteAsk) }} title="Nossa venda" />}
        {b.fair !== null && <div className="absolute -inset-y-0.5 w-px bg-ink" style={{ left: at(b.fair) }} title="Preço justo" />}
      </div>
      <div className="num mt-1.5 flex justify-between text-[11px] text-faint">
        <span>banda {b.widthBps !== null ? fmtBps(b.widthBps, 1) : 'sem ordens'}</span>
        <span>book {fmtBps(touchSpreadBps(v), 1)}</span>
      </div>
    </div>
  );
}

function BotCard({ v, now }: { v: BotView; now: number }) {
  const { points } = useSeries(v.botId);
  const h = botHealth(v, now);
  const p = pnlOf(v);
  const apr = aprOf(v);
  const stale = now - v.ts > 30_000;
  const eq = points.map((x) => x.equity).filter((x): x is number => x !== null);
  return (
    <Link href={hrefOf({ page: 'bot', botId: v.botId })}
      className={cx('glass group block p-4 transition-colors hover:border-brand/40', h.level === 'down' && 'border-down/40', h.level === 'warn' && 'border-warn/30')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold tracking-tight">{pairLabel(v.symbol, v.base, v.quote)}</span>
            <Pill tone="brand">{v.mode.toUpperCase()}</Pill>
          </div>
          <div className="mt-0.5 text-xs text-faint">MEXC · maker 0%</div>
        </div>
        <StatusBadge status={v.status} quoting={v.quoting} stale={stale} />
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <div className="label">PnL</div>
          <div className={cx('num text-xl font-semibold', p.abs !== null && p.abs > 0 ? 'text-up' : p.abs !== null && p.abs < 0 ? 'text-down' : '')}>{fmtUsd(p.abs, true)}</div>
          <div className="num text-xs text-muted">{fmtBps(p.bps, 1, true)} · equity {fmtUsd(v.pnl.equity)}</div>
        </div>
        <Sparkline values={eq} className="opacity-90" />
      </div>

      <div className="mt-4"><BandBar v={v} /></div>

      <dl className="num mt-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-raised/70 p-2">
          <dt className="label">Sel. adversa</dt>
          <dd className={cx('mt-0.5 text-sm', v.risk.adverseSelectionBps > 0 ? 'text-down' : 'text-ink')} title="Markout médio contra nós (bps). Quanto menor, melhor.">{fmtBps(v.risk.adverseSelectionBps, 1)}</dd>
        </div>
        <div className="rounded-xl bg-raised/70 p-2">
          <dt className="label">Fills</dt>
          <dd className="mt-0.5 text-sm">{fmtInt(v.counters.fills)}</dd>
        </div>
        <div className="rounded-xl bg-raised/70 p-2" title={apr === null ? `APR só com ≥ 24 janelas horárias (agora: ${v.edge.n})` : 'APR simples estimado pela média horária (não composto)'}>
          <dt className="label">APR est.</dt>
          <dd className={cx('mt-0.5 text-sm', apr !== null && apr > 0 && 'text-up', apr !== null && apr < 0 && 'text-down')}>{apr === null ? `${v.edge.n}/24 h` : fmtPct(apr, 0, true)}</dd>
        </div>
      </dl>

      <div className="mt-3">
        <div className="flex justify-between text-[11px] text-faint">
          <span>P(edge &gt; 0) ao vivo</span>
          <span className="num">{fmtPct(v.edge.pPositive, 0)}</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
          <div className={cx('h-full rounded-full', v.edge.pPositive >= 0.95 ? 'bg-up' : v.edge.pPositive >= 0.5 ? 'bg-brand' : 'bg-down')} style={{ width: `${Math.round(v.edge.pPositive * 100)}%` }} />
        </div>
      </div>
      {h.reasons.length > 0 && <div className={cx('mt-3 text-xs', h.level === 'down' ? 'text-down' : 'text-warn')}>{h.reasons.join(' · ')}</div>}
    </Link>
  );
}

export function Overview() {
  const views = useViews();
  const now = useServerNow();
  useLiveVersion();
  const t = totalsOf(views, now);
  const loading = live.epoch === 0;
  const alerts = views.map((v) => ({ v, h: botHealth(v, now) })).filter((x) => x.h.level === 'down');
  const best = views.length ? views.reduce((a, b) => (b.edge.pPositive > a.edge.pPositive ? b : a)) : undefined;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Visão geral</h1>
          <p className="text-sm text-muted">Shadow: dados reais da MEXC, ordens simuladas de forma conservadora. Nenhuma ordem real é enviada.</p>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="rounded-2xl border border-down/40 bg-down/10 p-3 text-sm text-down" role="alert">
          {alerts.map(({ v, h }) => (
            <div key={v.botId}><strong>{pairLabel(v.symbol, v.base, v.quote)}</strong>: {h.reasons.join(' · ')}</div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[104px]" />)
        ) : (
          <>
            <Stat label="Equity (shadow)" value={fmtUsd(t.equity)} sub={`início ${fmtUsd(t.startEquity)}`} />
            <Stat label="PnL total" value={fmtUsd(t.pnl, true)} tone={toneOf(t.pnl)} sub={fmtBps(t.pnlBps, 1, true)} hint="Realizado + marcação a mercado do inventário" />
            <Stat label="Bots cotando" value={`${t.running}/${t.bots}`} tone={t.attention ? 'warn' : 'neutral'} sub={t.attention ? `${t.attention} pedem atenção` : 'tudo em ordem'} />
            <Stat label="Pior drawdown" value={fmtPct(t.worstDrawdown, 2)} tone={t.worstDrawdown && t.worstDrawdown > 0.02 ? 'down' : 'neutral'} sub={`${fmtInt(t.fills)} fills no total`} />
          </>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <div>
          <h2 className="label mb-3">Posições (um bot por par)</h2>
          {loading ? (
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[330px]" />)}</div>
          ) : views.length === 0 ? (
            <Card><Empty title="Nenhum bot publicando ainda">Os bots aparecem aqui assim que o worker conecta ao Redis. Confira a página Sistema.</Empty></Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">{views.map((v) => <BotCard key={v.botId} v={v} now={now} />)}</div>
          )}
        </div>
        <aside className="space-y-3">
          <Card title="Edge ao vivo (melhor par)">
            {best ? (
              <div className="flex flex-col items-center">
                <Gauge value={best.edge.pGo} threshold={0.95} label={`P(μ > 1 bp/h) · ${pairLabel(best.symbol, best.base, best.quote)}`} />
                <p className="mt-2 text-center text-xs text-faint">
                  Indicador ao vivo <strong>sem correção</strong>. A decisão GO/NO-GO sai do protocolo pré-registrado (Bonferroni + autocorrelação), pelo avaliador oficial.
                </p>
              </div>
            ) : <Skeleton className="h-40" />}
          </Card>
          <Card title="Como ler">
            <ul className="space-y-2 text-xs text-muted">
              <li><span className="text-brand">■</span> Banda amarela: nossas ordens de compra e venda em volta do preço justo.</li>
              <li><span className="text-ink">│</span> Linha branca: preço justo (MEXC ajustada pela Binance).</li>
              <li><span className="text-faint">■</span> Faixa cinza: o book da MEXC (melhor compra → melhor venda).</li>
              <li>Seleção adversa alta significa que quem nos executa sabe mais que a gente. É o principal custo de um market maker.</li>
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}
