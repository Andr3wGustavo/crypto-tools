import type { BotEvent, StoredEvent } from '@cortex/shared';
import { useMemo, useState } from 'react';
import { Button, Card, Empty, Segmented, Skeleton, cx } from '../components/ui';
import { api } from '../lib/api';
import { botSymbol, fmtDateTime, fmtPrice, fmtQty, fmtUsd, toCsv } from '../lib/format';
import { live, useFills, useViews } from '../state';

type Fill = Extract<BotEvent, { k: 'fill' }>;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function Fills() {
  const views = useViews();
  const [bot, setBot] = useState<string>('all');
  const [side, setSide] = useState<'all' | 'BUY' | 'SELL'>('all');
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState<Set<string>>(new Set());
  const ids = bot === 'all' ? views.map((v) => v.botId) : [bot];
  const { fills, loading } = useFills(ids, 500);

  const rows = useMemo(() => fills.filter((s) => side === 'all' || (s.e as Fill).side === side), [fills, side]);
  const notional = rows.reduce((a, s) => a + (s.e as Fill).price * (s.e as Fill).qty, 0);

  /** Older pages, per bot, from the oldest fill already loaded (fills-stream ids). */
  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const done = new Set(exhausted);
      for (const b of ids) {
        if (done.has(b)) continue;
        const mine = live.fills.filter((s) => s.botId === b);
        const oldest = mine.length ? mine.reduce((a, s) => (s.e.ts < a.e.ts ? s : a)) : undefined;
        // A fill's id comes from the events stream (live) or the fills stream (REST); both are
        // `<ms>-<seq>` of the same write. Paging before the END of that millisecond can repeat
        // a sibling (deduplicated by fillId) but can never skip one.
        const before = oldest ? `${oldest.id.split('-')[0]}-9999999999` : undefined;
        const page = await api.fills(b, { limit: 500, before });
        if (page.events.length === 0 || page.next === null) done.add(b);
        live.seedEvents(page.events);
      }
      setExhausted(done);
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = () => {
    const csv = toCsv(
      ['ts_iso', 'bot', 'side', 'price', 'qty', 'notional_usdt', 'fee', 'fee_asset', 'fill_id', 'client_order_id'],
      rows.map((s: StoredEvent) => {
        const f = s.e as Fill;
        return [new Date(f.ts).toISOString(), s.botId, f.side, f.price, f.qty, f.price * f.qty, f.fee, f.feeAsset, f.fillId, f.clientOrderId];
      }),
    );
    download(`cortex-fills-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.csv`, csv);
  };

  const allExhausted = ids.every((b) => exhausted.has(b));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Fills</h1>
          <p className="text-sm text-muted">Execuções simuladas (shadow), com o mesmo formato do live.</p>
        </div>
        <Button onClick={exportCsv} disabled={rows.length === 0}>⇩ CSV ({rows.length})</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <select value={bot} onChange={(e) => setBot(e.target.value)} aria-label="Bot"
          className="rounded-[8px] border border-line-strong bg-raised px-3 py-1.5 text-sm outline-none focus:border-brand">
          <option value="all">Todos os pares</option>
          {views.map((v) => <option key={v.botId} value={v.botId}>{v.base}/{v.quote}</option>)}
        </select>
        <Segmented value={side} onChange={setSide} options={[{ value: 'all', label: 'Todos' }, { value: 'BUY', label: 'Compras' }, { value: 'SELL', label: 'Vendas' }]} />
        <span className="num text-xs text-muted">volume {fmtUsd(notional)}</span>
      </div>
      <Card pad={false}>
        {loading ? <Skeleton className="m-4 h-64" /> : rows.length === 0 ? <Empty title="Nenhum fill ainda">Market making paciente: em pares de 1 tick de spread, poucos fills por hora é o esperado.</Empty> : (
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[640px] text-sm">
              <thead><tr className="label text-left"><th className="px-4 py-3">Quando</th><th className="py-3">Par</th><th className="py-3">Lado</th><th className="py-3 text-right">Preço</th><th className="py-3 text-right">Qtd</th><th className="py-3 text-right">Valor</th><th className="px-4 py-3 text-right">Taxa</th></tr></thead>
              <tbody>{rows.map((s) => {
                const f = s.e as Fill;
                return (
                  <tr key={`${s.botId}|${f.fillId}`} className="border-t border-line/60 hover:bg-raised/50">
                    <td className="px-4 py-2 text-muted">{fmtDateTime(f.ts)}</td>
                    <td className="py-2 font-sans font-semibold">{botSymbol(s.botId)}</td>
                    <td className={cx('py-2', f.side === 'BUY' ? 'text-up' : 'text-down')}>{f.side === 'BUY' ? 'Compra' : 'Venda'}</td>
                    <td className="py-2 text-right">{fmtPrice(f.price)}</td>
                    <td className="py-2 text-right">{fmtQty(f.qty)}</td>
                    <td className="py-2 text-right">{fmtUsd(f.price * f.qty)}</td>
                    <td className="px-4 py-2 text-right text-muted">{f.fee} {f.feeAsset}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </Card>
      {rows.length > 0 && !allExhausted && (
        <div className="flex justify-center"><Button onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? 'Carregando…' : 'Carregar mais antigos'}</Button></div>
      )}
    </div>
  );
}
