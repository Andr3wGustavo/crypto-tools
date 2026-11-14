import type { BotEvent, StoredEvent } from '@cortex/shared';
import { botSymbol, fmtBps, fmtPrice, fmtQty, fmtTime, shortAddr } from '../lib/format';
import { Pill, cx, type Tone } from './ui';

const KIND: Record<BotEvent['k'], { label: string; tone: Tone }> = {
  fill: { label: 'fill', tone: 'brand' },
  order: { label: 'ordem', tone: 'neutral' },
  status: { label: 'status', tone: 'info' },
  risk: { label: 'risco', tone: 'warn' },
  error: { label: 'erro', tone: 'down' },
  edge: { label: 'edge', tone: 'info' },
  reconcile: { label: 'reconc.', tone: 'down' },
  markout: { label: 'markout', tone: 'neutral' },
  command: { label: 'comando', tone: 'brand' },
  treasury: { label: 'tesouro', tone: 'brand' },
  withdrawal: { label: 'saque', tone: 'info' },
};

const WD: Record<string, string> = { PENDING: 'reservado', SENT: 'enviado', CONFIRMED: 'confirmado', FAILED: 'falhou (reserva devolvida)' };

const CMD: Record<string, string> = { pause: 'pausar', resume: 'retomar', reset_halt: 'resetar halt', reset_kill: 'resetar kill' };

/** One human sentence per event. */
export function describe(e: BotEvent): { text: string; tone: Tone } {
  switch (e.k) {
    case 'fill':
      return { text: `${e.side === 'BUY' ? 'Comprou' : 'Vendeu'} ${fmtQty(e.qty)} @ ${fmtPrice(e.price)}${e.fee ? ` · taxa ${e.fee}` : ''}`, tone: e.side === 'BUY' ? 'up' : 'down' };
    case 'order':
      return e.op === 'place'
        ? { text: `Cotou ${e.side === 'BUY' ? 'compra' : 'venda'} ${e.qty} @ ${e.price}`, tone: 'neutral' }
        : { text: `Cancelou ${e.clientOrderId.slice(-6)} (${e.reason ?? '—'})`, tone: 'neutral' };
    case 'status':
      return { text: `Status → ${e.status}${e.quoting ? '' : ' (sem cotar)'}: ${e.reason}`, tone: e.status === 'running' ? 'up' : 'warn' };
    case 'risk':
      return e.action === 'ok'
        ? { text: 'Risco: normalizado', tone: 'up' }
        : { text: `Risco: ${e.action}${e.violations.length ? ` · ${e.violations.join('; ')}` : ''}`, tone: 'warn' };
    case 'error':
      return { text: e.message, tone: 'down' };
    case 'edge':
      return { text: `Janela fechada: ${fmtBps(e.returnBps, 2, true)} · n=${e.n} · P(μ>0)=${(e.pPositive * 100).toFixed(0)}% · ${e.verdict}`, tone: e.returnBps >= 0 ? 'up' : 'down' };
    case 'reconcile':
      return { text: e.ok ? 'Reconciliação ok' : `Divergência ledger × estratégia (${e.diffs}): halt`, tone: e.ok ? 'up' : 'down' };
    case 'markout':
      return { text: `Markout ${e.horizonMs / 1000}s: ${fmtBps(e.bps, 2, true)}`, tone: e.bps >= 0 ? 'up' : 'down' };
    case 'command': {
      const who = e.actor ? (e.actor.startsWith('service:') ? e.actor : shortAddr(e.actor)) : '?';
      const what = e.command ? CMD[e.command] ?? e.command : 'comando inválido';
      return e.applied ? { text: `${who}: ${what} (aplicado)`, tone: 'brand' } : { text: `${who}: ${what} recusado (${e.reason ?? '—'})`, tone: 'down' };
    }
    case 'treasury':
      return { text: `Lucro confirmado → tesouro: +${e.skim} (tesouro ${e.treasury})`, tone: 'up' };
    case 'withdrawal':
      return {
        text: `Saque ${e.amount} ${WD[e.status] ?? e.status}${e.fee !== null ? ` · taxa ${e.fee}` : ''}${e.reason ? ` · ${e.reason}` : ''}`,
        tone: e.status === 'CONFIRMED' ? 'up' : e.status === 'FAILED' ? 'down' : 'info',
      };
  }
}

const toneText: Record<Tone, string> = { neutral: 'text-ink', up: 'text-up', down: 'text-down', warn: 'text-warn', brand: 'text-brand', info: 'text-info' };

export function EventRow({ s, showBot = true }: { s: StoredEvent; showBot?: boolean }) {
  const k = KIND[s.e.k];
  const d = describe(s.e);
  return (
    <div className="grid grid-cols-[64px_auto_1fr] items-baseline gap-2 border-b border-line/50 px-2 py-1.5 text-sm last:border-0 sm:grid-cols-[72px_84px_1fr]">
      <span className="num text-xs text-faint">{fmtTime(s.e.ts)}</span>
      <span><Pill tone={k.tone}>{k.label}</Pill></span>
      <span className={cx('min-w-0 break-words', toneText[d.tone])}>
        {showBot && <span className="mr-2 font-semibold text-muted">{botSymbol(s.botId)}</span>}
        {d.text}
      </span>
    </div>
  );
}
