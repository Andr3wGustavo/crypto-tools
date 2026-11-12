import { useState } from 'react';
import { sendCommand } from '../components/Controls';
import { EventRow } from '../components/EventRow';
import { Button, Card, Empty, Link, Modal, StatusBadge, cx, useToast } from '../components/ui';
import { botHealth, pnlOf } from '../lib/derive';
import { fmtAge, fmtInt, fmtPct, pairLabel } from '../lib/format';
import { hrefOf } from '../lib/router';
import { useEvents, useServerNow, useViews } from '../state';

/**
 * Risk Center. The kill switch here PAUSES every bot: in shadow that is the safe stop (cancel
 * all, no new quotes) and it needs no 2FA, so it is always one confirmation away. Resuming is
 * per bot, with 2FA.
 */
export function Risk() {
  const views = useViews();
  const now = useServerNow();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = views.map((v) => v.botId);
  const { events } = useEvents(ids, ['risk', 'status', 'error', 'reconcile', 'command'], 100);

  const pauseAll = async () => {
    setBusy(true);
    const targets = views.filter((v) => v.status === 'running');
    const results = await Promise.allSettled(targets.map((v) => sendCommand(v.botId, 'pause')));
    const failed = results.filter((r) => r.status === 'rejected').length;
    setBusy(false);
    setConfirm(false);
    if (targets.length === 0) toast('Nenhum bot estava cotando.', 'neutral');
    else if (failed) toast(`${targets.length - failed}/${targets.length} pausados. ${failed} falharam: tente de novo.`, 'down');
    else toast(`Pausa enviada para ${targets.length} bot(s). Confirmação no log abaixo.`, 'brand');
  };

  const running = views.filter((v) => v.status === 'running').length;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Centro de risco</h1>
        <p className="text-sm text-muted">Limites são aplicados pelo worker (fail-closed). Aqui você vê e age.</p>
      </div>

      <section className="glass flex flex-col items-start justify-between gap-4 border-down/40 p-5 sm:flex-row sm:items-center">
        <div>
          <div className="text-lg font-bold text-down">Kill switch</div>
          <p className="max-w-xl text-sm text-muted">Pausa todos os bots: cancela as ordens e para de cotar. Não pede 2FA (parar sempre tem que ser fácil). Para retomar, cada bot pede o código 2FA.</p>
        </div>
        <Button variant="danger" className="px-6 py-3 text-base" disabled={busy || running === 0} onClick={() => setConfirm(true)}>
          Pausar todos ({running})
        </Button>
      </section>
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Pausar todos os bots?">
        <p className="text-sm text-muted">{running} bot(s) vão cancelar as ordens e parar de cotar.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="subtle" onClick={() => setConfirm(false)}>Cancelar</Button>
          <Button variant="danger" disabled={busy} onClick={() => void pauseAll()}>{busy ? 'Enviando…' : 'Pausar todos'}</Button>
        </div>
      </Modal>

      <Card title="Bots" pad={false}>
        {views.length === 0 ? <Empty title="Nenhum bot publicando" /> : (
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[640px] text-sm">
              <thead><tr className="label text-left"><th className="px-4 pb-2">Par</th><th className="pb-2">Status</th><th className="pb-2">Halt</th><th className="pb-2 text-right">Drawdown</th><th className="pb-2 text-right">Erros/min</th><th className="pb-2 text-right">Último dado</th><th className="px-4 pb-2">Alertas</th></tr></thead>
              <tbody>{views.map((v) => {
                const h = botHealth(v, now);
                return (
                  <tr key={v.botId} className="border-t border-line/60">
                    <td className="px-4 py-2"><Link href={hrefOf({ page: 'bot', botId: v.botId })} className="font-semibold hover:text-brand">{pairLabel(v.symbol, v.base, v.quote)}</Link></td>
                    <td className="py-2"><StatusBadge status={v.status} quoting={v.quoting} stale={now - v.ts > 30_000} /></td>
                    <td className="py-2 text-muted">{v.haltRule ?? '—'}</td>
                    <td className="py-2 text-right">{fmtPct(pnlOf(v).drawdown, 2)}</td>
                    <td className={cx('py-2 text-right', v.health.errorsLastMin > 0 && 'text-warn')}>{fmtInt(v.health.errorsLastMin)}</td>
                    <td className="py-2 text-right">{fmtAge(now - v.ts)}</td>
                    <td className={cx('px-4 py-2 font-sans text-xs', h.level === 'down' ? 'text-down' : 'text-warn')}>{h.reasons.join(' · ') || <span className="text-faint">—</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Incidentes e comandos" pad={false}>
        <div className="max-h-[480px] overflow-y-auto px-2 pb-2">
          {events.length === 0 ? <Empty title="Nenhum incidente" icon="✓">Riscos, mudanças de status, erros e comandos aparecem aqui.</Empty> : events.map((e) => <EventRow key={`${e.botId}|${e.id}`} s={e} />)}
        </div>
      </Card>
    </div>
  );
}
