import { useQuery } from '@tanstack/react-query';
import { Card, Empty, KV, Link, Pill, Skeleton, StatusBadge, cx } from '../components/ui';
import { api } from '../lib/api';
import { fmtAge, fmtDuration, fmtInt, pairLabel } from '../lib/format';
import { hrefOf } from '../lib/router';
import { live, useLiveVersion, useServerNow, useViews } from '../state';

export function System() {
  const views = useViews();
  const now = useServerNow();
  useLiveVersion();
  const sys = useQuery({ queryKey: ['system'], queryFn: api.system, refetchInterval: 5_000 });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2 md:hidden">
        <Link href="/treasury" className="glass px-3 py-2 text-sm">◎ Tesouro</Link>
        <Link href="/settings" className="glass px-3 py-2 text-sm">⚙ Ajustes</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Sistema</h1>
        <p className="text-sm text-muted">Saúde dos processos, dos feeds e da conexão ao vivo.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card title="API">
          {sys.isPending ? <Skeleton className="h-32" /> : sys.isError ? <p className="text-sm text-down">API indisponível: {(sys.error as Error).message}</p> : (
            <>
              <KV k="Versão" v={sys.data.api.version} />
              <KV k="No ar há" v={fmtDuration(sys.data.api.uptimeS * 1000)} />
              <KV k="Redis" v={sys.data.api.redis ? 'ok' : 'fora'} tone={sys.data.api.redis ? 'up' : 'down'} />
              <KV k="Dashboards conectados" v={fmtInt(sys.data.api.wsClients)} />
              <KV k="Memória (RSS)" v={`${fmtInt(sys.data.api.rssMb)} MB`} />
            </>
          )}
        </Card>
        <Card title="Conexão ao vivo (este navegador)">
          <KV k="Estado" v={live.state} tone={live.state === 'live' ? 'up' : 'warn'} />
          <KV k="Última mensagem" v={live.lastMessageAt ? fmtAge(Date.now() - live.lastMessageAt) : '—'} />
          <KV k="Desvio do relógio local" v={`${fmtInt(live.clockOffsetMs)} ms`} tone={Math.abs(live.clockOffsetMs) > 2_000 ? 'warn' : 'neutral'} hint="servidor − este aparelho" />
          <KV k="Reconexões (snapshots)" v={fmtInt(Math.max(0, live.epoch - 1))} />
          <KV k="Eventos em memória" v={`${fmtInt(live.events.length)} + ${fmtInt(live.fills.length)} fills`} />
        </Card>
        <Card title="Infra">
          <p className="text-sm text-muted">CPU, disco, containers e backups entram com o VPS (E4): node exporter + healthchecks.io. Até lá, a saúde vem dos próprios processos.</p>
        </Card>
      </div>
      <Card title="Workers" pad={false}>
        {views.length === 0 ? <Empty title="Nenhum worker publicando" /> : (
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[760px] text-sm">
              <thead><tr className="label text-left"><th className="px-4 pb-2">Par</th><th className="pb-2">Status</th><th className="pb-2 text-right">Último dado</th><th className="pb-2 text-right">MEXC</th><th className="pb-2 text-right">Binance</th><th className="pb-2 text-right">Lag p99</th><th className="pb-2 text-right">Relógio</th><th className="pb-2 text-right">Registros</th><th className="px-4 pb-2">Versão · experimento</th></tr></thead>
              <tbody>{views.map((v) => (
                <tr key={v.botId} className="border-t border-line/60">
                  <td className="px-4 py-2 font-sans"><Link href={hrefOf({ page: 'bot', botId: v.botId })} className="font-semibold hover:text-brand">{pairLabel(v.symbol, v.base, v.quote)}</Link></td>
                  <td className="py-2"><StatusBadge status={v.status} quoting={v.quoting} stale={now - v.ts > 30_000} /></td>
                  <td className={cx('py-2 text-right', now - v.ts > 30_000 && 'text-down')}>{fmtAge(now - v.ts)}</td>
                  <td className="py-2 text-right">{fmtAge(v.feeds.mexcAgeMs)}</td>
                  <td className="py-2 text-right">{fmtAge(v.feeds.binanceAgeMs)}</td>
                  <td className={cx('py-2 text-right', v.health.eventLoopLagMs > 50 && 'text-warn')}>{v.health.eventLoopLagMs} ms</td>
                  <td className="py-2 text-right">{v.health.clockSkewMs} ms</td>
                  <td className="py-2 text-right">{fmtInt(v.counters.records)}</td>
                  <td className="px-4 py-2 text-xs text-muted">{v.version} · {v.run}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {sys.data && sys.data.bots.some((b) => b.ageMs > 30_000) && <Pill tone="down">Algum worker parou de publicar: confira o processo e o Redis.</Pill>}
    </div>
  );
}
