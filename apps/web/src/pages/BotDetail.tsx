import type { BotView } from '@cortex/shared';
import { EquityChart, PriceChart } from '../components/charts';
import { Controls } from '../components/Controls';
import { EventRow } from '../components/EventRow';
import { BandBar } from './Overview';
import { Card, Empty, KV, Link, Pill, Skeleton, StatusBadge, cx, toneOf } from '../components/ui';
import { aprOf, botHealth, pnlOf, touchSpreadBps } from '../lib/derive';
import { fmtAge, fmtBps, fmtDuration, fmtInt, fmtPct, fmtPrice, fmtQty, fmtUsd, pairLabel } from '../lib/format';
import { live, useEvents, useFills, useSeries, useServerNow, useView } from '../state';

/** PnL waterfall: start → realised → mark-to-market of the inventory → now. */
function Waterfall({ v }: { v: BotView }) {
  const start = v.pnl.startEquity;
  const end = v.pnl.equity;
  if (start === null || end === null) return <Empty title="Sem preço ainda" />;
  // The residual (fees in base, rounding) is shown explicitly rather than hidden in a bar.
  const other = end - start - v.pnl.realized - v.pnl.unrealized;
  const rows: Array<{ k: string; x: number; kind: 'total' | 'delta' }> = [
    { k: 'Início', x: start, kind: 'total' },
    { k: 'Realizado', x: v.pnl.realized, kind: 'delta' },
    { k: 'Inventário (MTM)', x: v.pnl.unrealized, kind: 'delta' },
    ...(Math.abs(other) > 1e-9 ? [{ k: 'Outros', x: other, kind: 'delta' as const }] : []),
    { k: 'Agora', x: end, kind: 'total' },
  ];
  const maxDelta = Math.max(1e-9, ...rows.filter((r) => r.kind === 'delta').map((r) => Math.abs(r.x)));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.k} className="grid grid-cols-[120px_1fr_auto] items-center gap-3 text-sm">
          <span className="text-muted">{r.k}</span>
          {r.kind === 'delta' ? (
            <div className="relative h-2.5 rounded bg-raised">
              <div className={cx('absolute inset-y-0 rounded', r.x >= 0 ? 'left-1/2 bg-up' : 'right-1/2 bg-down')} style={{ width: `${(Math.abs(r.x) / maxDelta) * 50}%` }} />
              <div className="absolute inset-y-[-3px] left-1/2 w-px bg-line-strong" />
            </div>
          ) : <div className="h-2.5 rounded bg-brand/25" />}
          <span className={cx('num text-right', r.kind === 'delta' && (r.x > 0 ? 'text-up' : r.x < 0 ? 'text-down' : ''))}>{fmtUsd(r.x, r.kind === 'delta')}</span>
        </div>
      ))}
    </div>
  );
}

export function BotDetail({ botId }: { botId: string }) {
  const v = useView(botId);
  const now = useServerNow();
  const { points, loading } = useSeries(botId);
  const { fills } = useFills([botId], 300);
  const { events } = useEvents([botId], ['status', 'risk', 'error', 'reconcile', 'command', 'edge', 'fill'], 100);

  if (!v) {
    return live.epoch === 0 ? <Skeleton className="h-96" /> : (
      <Card><Empty title="Bot não encontrado">Esse bot não está publicando. <Link href="/" className="text-brand hover:underline">Voltar</Link></Empty></Card>
    );
  }
  const h = botHealth(v, now);
  const p = pnlOf(v);
  const apr = aprOf(v);
  const stale = now - v.ts > 30_000;
  const inventoryValue = v.market.fair !== null ? v.balances.base * v.market.fair : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/" className="text-muted hover:text-brand" title="Voltar">←</Link>
          <h1 className="text-2xl font-bold tracking-tight">{pairLabel(v.symbol, v.base, v.quote)}</h1>
          <Pill tone="brand">{v.mode.toUpperCase()}</Pill>
          <StatusBadge status={v.status} quoting={v.quoting} stale={stale} />
          {v.market.toxic && <Pill tone="warn">fluxo tóxico</Pill>}
          {v.reduceOnly && <Pill tone="warn">reduce-only</Pill>}
        </div>
        <Controls v={v} />
      </div>
      {h.reasons.length > 0 && <div className={cx('rounded-xl border px-3 py-2 text-sm', h.level === 'down' ? 'border-down/40 bg-down/10 text-down' : 'border-warn/30 bg-warn/10 text-warn')}>{h.reasons.join(' · ')}</div>}

      <div className="grid gap-4 xl:grid-cols-[1fr_340px] xl:items-start">
        <Card title="Preço ao vivo" action={<span className="num text-xs text-faint">{fmtPrice(v.market.mid)} · {fills.length} fills no período</span>} pad={false}>
          <div className="px-2 pb-2">
            {loading ? <Skeleton className="m-2 h-[320px]" /> : points.length < 2 ? <Empty title="Juntando pontos">Um ponto a cada 5 s. O gráfico aparece em instantes.</Empty> : <PriceChart points={points} fills={fills} />}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-[11px] text-faint">
            <span><span className="text-brand">━</span> mid MEXC</span><span>╌ mid Binance</span><span><span className="text-ink">━</span> justo</span>
            <span><span className="text-up">┈</span> nossa compra</span><span><span className="text-down">┈</span> nossa venda</span><span><span className="text-up">▲</span>/<span className="text-down">▼</span> fills</span>
          </div>
        </Card>
        <div className="space-y-4">
          <Card title="Book e banda">
            <BandBar v={v} />
            <div className="mt-3">
              <KV k="Book (compra / venda)" v={`${fmtPrice(v.market.bestBid)} / ${fmtPrice(v.market.bestAsk)}`} />
              <KV k="Nossas ordens" v={`${fmtPrice(v.market.quoteBid)} / ${fmtPrice(v.market.quoteAsk)}`} />
              <KV k="Spread do book" v={fmtBps(touchSpreadBps(v), 2)} />
              <KV k="Meio-spread alvo" v={fmtBps(v.market.halfSpreadBps, 2)} />
              <KV k="Binance (referência)" v={fmtPrice(v.market.refMid)} />
            </div>
          </Card>
          <Card title="Inventário">
            <KV k={v.base} v={fmtQty(v.balances.base)} />
            <KV k={v.quote} v={fmtUsd(v.balances.quote)} />
            <KV k="Valor do inventário" v={fmtUsd(inventoryValue)} hint="base × preço justo" />
            <KV k="Equity" v={fmtUsd(v.pnl.equity)} />
          </Card>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Cascata de PnL"><Waterfall v={v} /><div className="num mt-3 text-xs text-muted">Total {fmtUsd(p.abs, true)} ({fmtBps(p.bps, 1, true)}) · drawdown {fmtPct(p.drawdown, 2)}</div></Card>
        <Card title="Risco e mercado">
          <KV k="Volatilidade (σ)" v={fmtBps(v.risk.sigmaBps, 2)} />
          <KV k="Seleção adversa" v={fmtBps(v.risk.adverseSelectionBps, 2)} tone={v.risk.adverseSelectionBps > 0 ? 'down' : 'neutral'} hint="Markout médio contra nós" />
          <KV k="Markouts medidos" v={fmtInt(v.risk.markoutsObserved)} />
          <KV k="Regra de halt" v={v.haltRule ?? '—'} tone={v.haltRule ? 'down' : 'neutral'} />
          <KV k="Erros (1 min)" v={fmtInt(v.health.errorsLastMin)} tone={v.health.errorsLastMin ? 'warn' : 'neutral'} />
        </Card>
        <Card title="Edge (indicador ao vivo)">
          <KV k="Janelas horárias (n)" v={fmtInt(v.edge.n)} />
          <KV k="Média ± desvio" v={`${fmtBps(v.edge.meanBps, 2, true)} ± ${fmtBps(v.edge.sdBps, 1)}`} tone={toneOf(v.edge.meanBps)} />
          <KV k="P(μ > 0)" v={fmtPct(v.edge.pPositive, 1)} />
          <KV k="P(μ > 1 bp/h)" v={fmtPct(v.edge.pGo, 1)} />
          <KV k="APR simples" v={apr === null ? `precisa de 24 h (${v.edge.n})` : fmtPct(apr, 1, true)} tone={toneOf(apr)} />
          <p className="mt-2 text-[11px] leading-relaxed text-faint">Sem correção para vários pares nem autocorrelação. O GO/NO-GO oficial vem do protocolo pré-registrado.</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card title="Equity" pad={false}><div className="px-2 pb-2">{points.length < 2 ? <Skeleton className="m-2 h-[200px]" /> : <EquityChart points={points} />}</div></Card>
        <Card title="Ordens abertas">
          {v.orders.length === 0 ? <Empty title="Sem ordens abertas" icon="○">{v.quoting ? 'Aguardando a próxima cotação.' : 'O bot não está cotando.'}</Empty> : (
            <table className="num w-full text-sm">
              <thead><tr className="label text-left"><th className="pb-2">Lado</th><th className="pb-2 text-right">Preço</th><th className="pb-2 text-right">Qtd</th><th className="pb-2 text-right">Idade</th></tr></thead>
              <tbody>{v.orders.map((o) => (
                <tr key={o.clientOrderId} className="border-t border-line/60">
                  <td className={cx('py-1.5', o.side === 'BUY' ? 'text-up' : 'text-down')}>{o.side === 'BUY' ? 'Compra' : 'Venda'}</td>
                  <td className="py-1.5 text-right">{o.price}</td>
                  <td className="py-1.5 text-right">{fmtQty(o.qty)}</td>
                  <td className="py-1.5 text-right text-muted">{fmtAge(v.ts - o.createdTs)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card title="Eventos recentes" pad={false}>
          <div className="max-h-[420px] overflow-y-auto px-2 pb-2">
            {events.length === 0 ? <Empty title="Nada ainda" /> : events.slice(0, 100).map((e) => <EventRow key={`${e.botId}|${e.id}`} s={e} showBot={false} />)}
          </div>
        </Card>
        <Card title="Saúde">
          <KV k="Último dado" v={fmtAge(now - v.ts)} tone={stale ? 'down' : 'neutral'} />
          <KV k="Feed MEXC" v={fmtAge(v.feeds.mexcAgeMs)} />
          <KV k="Feed Binance" v={fmtAge(v.feeds.binanceAgeMs)} />
          <KV k="Lag do event loop p99" v={`${fmtInt(v.health.eventLoopLagMs)} ms`} tone={v.health.eventLoopLagMs > 50 ? 'warn' : 'neutral'} />
          <KV k="Desvio do relógio" v={`${fmtInt(v.health.clockSkewMs)} ms`} />
          <KV k="Registros" v={fmtInt(v.counters.records)} />
          <KV k="Processo no ar há" v={fmtDuration(now - v.startedAt)} />
          <KV k="Experimento" v={v.run} hint="Diretório da config pré-registrada" />
          <KV k="Versão" v={v.version} />
        </Card>
      </div>
    </div>
  );
}
