import type { BotEventKind } from '@cortex/shared';
import { useDeferredValue, useMemo, useState } from 'react';
import { EventRow, describe } from '../components/EventRow';
import { Button, Card, Empty, Pill, Skeleton, cx } from '../components/ui';
import { live, useEvents, useLiveVersion, useViews } from '../state';

const KINDS: Array<{ k: BotEventKind; label: string }> = [
  { k: 'fill', label: 'Fills' }, { k: 'order', label: 'Ordens' }, { k: 'status', label: 'Status' }, { k: 'risk', label: 'Risco' },
  { k: 'error', label: 'Erros' }, { k: 'edge', label: 'Edge' }, { k: 'markout', label: 'Markouts' }, { k: 'reconcile', label: 'Reconc.' }, { k: 'command', label: 'Comandos' },
];
const DEFAULT = new Set<BotEventKind>(['fill', 'status', 'risk', 'error', 'edge', 'reconcile', 'command']);

export function Logs() {
  const views = useViews();
  useLiveVersion();
  const [kinds, setKinds] = useState<Set<BotEventKind>>(DEFAULT);
  const [q, setQ] = useState('');
  const [frozen, setFrozen] = useState<number | null>(null);
  const query = useDeferredValue(q.trim().toLowerCase());
  const { events, loading } = useEvents(views.map((v) => v.botId), undefined, 300);

  const rows = useMemo(() => {
    const out = events.filter((s) => kinds.has(s.e.k) && (frozen === null || s.e.ts <= frozen));
    if (!query) return out.slice(0, 500);
    return out.filter((s) => `${s.botId} ${describe(s.e).text}`.toLowerCase().includes(query)).slice(0, 500);
  }, [events, kinds, query, frozen]);

  const toggle = (k: BotEventKind) => setKinds((cur) => {
    const n = new Set(cur);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Logs</h1>
          <p className="text-sm text-muted">Eventos ao vivo de todos os bots: o que o motor decidiu e por quê.</p>
        </div>
        <Button onClick={() => setFrozen((f) => (f === null ? live.serverNow() : null))}>{frozen === null ? '❚❚ Congelar' : '▶ Ao vivo'}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {KINDS.map(({ k, label }) => (
          <button key={k} type="button" onClick={() => toggle(k)}
            className={cx('rounded-full border px-2.5 py-1 text-xs font-medium transition-colors', kinds.has(k) ? 'border-brand/50 bg-brand/10 text-brand' : 'border-line text-faint hover:text-ink')}>
            {label}
          </button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…" aria-label="Buscar nos logs"
          className="ml-auto w-full rounded-xl border border-line-strong bg-raised px-3 py-1.5 text-sm outline-none focus:border-brand sm:w-64" />
      </div>
      {live.eventsDropped > 0 && <Pill tone="warn">{live.eventsDropped} eventos ao vivo não couberam no feed. Recarregue para ver todos.</Pill>}
      <Card pad={false}>
        <div className="max-h-[70dvh] overflow-y-auto px-2 py-1">
          {loading ? <Skeleton className="m-2 h-64" /> : rows.length === 0 ? <Empty title="Nada com esses filtros" /> : rows.map((s) => <EventRow key={`${s.botId}|${s.id}`} s={s} />)}
        </div>
      </Card>
    </div>
  );
}
