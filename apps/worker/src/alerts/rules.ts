import type { BotEvent, BotView } from '@cortex/shared';

/**
 * Alert rules for an unattended (AFK) farm. Pure and deterministic: the caller feeds events and
 * periodic view snapshots with explicit timestamps, and gets back the alerts to deliver.
 *
 * Design:
 * - A *condition* (stale bot, dead feed, high drawdown, error burst) alerts once when it starts
 *   and once when it clears ("resolved"). It re-alerts only after `repeatMs` if still active,
 *   so a stuck problem reminds you without spamming.
 * - An *event* (halt, kill, reconcile divergence, refused command) always alerts: each one
 *   is a distinct fact you must know about.
 * - Nothing here can act on the farm: alerts only inform. Stopping is done by the engine
 *   itself (fail-closed) or by you.
 */
export type Severity = 'critical' | 'warn' | 'info' | 'resolved';

export interface Alert {
  severity: Severity;
  botId: string | null;
  title: string;
  text: string;
  ts: number;
}

export interface AlertRulesConfig {
  /** View older than this ⇒ the worker stopped publishing (crash, Redis, VPS). */
  staleViewMs: number;
  /** MEXC feed silent for this long while the worker is alive. */
  staleFeedMs: number;
  /** Drawdown (fraction below peak equity) that warns. */
  drawdownWarn: number;
  /** Errors within `errorWindowMs` that warn. */
  errorBurst: number;
  errorWindowMs: number;
  /** Re-alert interval for a condition that stays active. */
  repeatMs: number;
  /** An automatic pause (stale data, toxic flow…) alerts only if it lasts this long. */
  autoPauseMs: number;
}

export const DEFAULT_ALERT_RULES: AlertRulesConfig = {
  staleViewMs: 120_000,
  staleFeedMs: 120_000,
  drawdownWarn: 0.03,
  errorBurst: 5,
  errorWindowMs: 5 * 60_000,
  repeatMs: 6 * 3_600_000,
  autoPauseMs: 60_000,
};

const sym = (botId: string) => botId.split(':')[1] ?? botId;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const CMD: Record<string, string> = { pause: 'pausar', resume: 'retomar', reset_halt: 'resetar halt', reset_kill: 'resetar kill' };

interface Condition {
  since: number;
  lastAlert: number;
}

export class AlertRules {
  private readonly active = new Map<string, Condition>();
  private readonly errors = new Map<string, number[]>();
  private readonly lastStatus = new Map<string, string>();
  /** Automatic pauses in progress: since when, and why. */
  private readonly autoPause = new Map<string, { since: number; reason: string }>();
  /** Live venue holds in progress (user stream down, re-syncing, rate limit, fatal…). */
  private readonly venueHold = new Map<string, { since: number; reason: string }>();

  constructor(private readonly cfg: AlertRulesConfig = DEFAULT_ALERT_RULES) {}

  /** One event from a bot's stream. */
  onEvent(botId: string, e: BotEvent, now: number): Alert[] {
    const s = sym(botId);
    switch (e.k) {
      case 'status': {
        // Live venue holds: the status stays the same, only quoting stops.
        if (e.reason.startsWith('venue_hold:')) {
          const why = e.reason.slice('venue_hold:'.length);
          const was = this.venueHold.get(botId);
          this.venueHold.set(botId, { since: was?.since ?? now, reason: why });
          if (why.startsWith('fatal:') && !was?.reason.startsWith('fatal:')) {
            return [{ severity: 'critical', botId, ts: now, title: `${s}: live travado (${why.slice(6)})`, text: `A corretora ou a conta estão num estado que exige você: ${why.slice(6)}. Ordens canceladas, nada é cotado. Corrija e resete o halt (pede 2FA).` }];
          }
          return [];
        }
        if (e.reason === 'venue_ok') {
          const was = this.venueHold.get(botId);
          this.venueHold.delete(botId);
          return was?.reason.startsWith('fatal:') ? [{ severity: 'resolved', botId, ts: now, title: `${s}: live liberado`, text: `O bloqueio (${was.reason.slice(6)}) foi resolvido; o bot volta a cotar.` }] : [];
        }
        const prev = this.lastStatus.get(botId);
        this.lastStatus.set(botId, e.status);
        if (e.status === 'paused' && !e.reason.startsWith('manual')) {
          if (!this.autoPause.has(botId)) this.autoPause.set(botId, { since: now, reason: e.reason });
        } else this.autoPause.delete(botId);
        if (prev === e.status) return [];
        if (e.status === 'killed') return [{ severity: 'critical', botId, ts: now, title: `${s}: KILL`, text: `O bot parou tudo (kill). Motivo: ${e.reason}. Ordens canceladas; ele não volta sozinho.` }];
        if (e.status === 'halted') return [{ severity: 'critical', botId, ts: now, title: `${s}: HALT`, text: `Halt por regra de risco: ${e.reason}. Ordens canceladas. Para voltar: resetar halt (pede 2FA).` }];
        if (e.status === 'running' && (prev === 'halted' || prev === 'killed')) return [{ severity: 'resolved', botId, ts: now, title: `${s}: voltou a operar`, text: `Status: running (${e.reason}).` }];
        return [];
      }
      case 'reconcile':
        return e.ok ? [] : [{ severity: 'critical', botId, ts: now, title: `${s}: divergência de reconciliação`, text: `Ledger e estratégia divergiram em ${e.diffs} ativo(s). O bot entrou em halt. Investigue antes de resetar.` }];
      case 'error': {
        const w = (this.errors.get(botId) ?? []).filter((t) => t > now - this.cfg.errorWindowMs);
        w.push(now);
        this.errors.set(botId, w);
        if (w.length >= this.cfg.errorBurst) {
          return this.condition(`errors:${botId}`, true, now, {
            severity: 'warn', botId, ts: now, title: `${s}: rajada de erros`, text: `${w.length} erros em ${Math.round(this.cfg.errorWindowMs / 60_000)} min. Último: ${e.message}`,
          });
        }
        return [];
      }
      case 'command':
        return e.applied
          ? [{ severity: 'info', botId, ts: now, title: `${s}: comando ${CMD[e.command ?? ''] ?? e.command}`, text: `Aplicado. Quem: ${e.actor ?? '?'}.` }]
          : [{ severity: 'warn', botId, ts: now, title: `${s}: comando recusado`, text: `${CMD[e.command ?? ''] ?? e.command ?? 'inválido'} recusado pelo worker (${e.reason ?? '—'}). Quem: ${e.actor ?? '?'}.` }];
      default:
        return [];
    }
  }

  /** Periodic check of every bot's latest view (staleness, feeds, drawdown). */
  onViews(views: Array<{ botId: string; view: BotView | undefined }>, now: number): Alert[] {
    const out: Alert[] = [];
    for (const { botId, view } of views) {
      const s = sym(botId);
      const age = view ? now - view.ts : Number.POSITIVE_INFINITY;
      const stale = age > this.cfg.staleViewMs;
      out.push(...this.condition(`stale:${botId}`, stale, now, {
        severity: 'critical', botId, ts: now, title: `${s}: sem dados`,
        text: view ? `O worker não publica há ${Math.round(age / 1000)} s (processo, Redis ou VPS). O dead-man também deve avisar.` : 'Bot registrado mas sem estado publicado.',
      }, { severity: 'resolved', botId, ts: now, title: `${s}: dados de volta`, text: 'O worker voltou a publicar.' }));
      if (!view || stale) continue;
      if (!this.lastStatus.has(botId)) this.lastStatus.set(botId, view.status);

      const ap = this.autoPause.get(botId);
      out.push(...this.condition(`autopause:${botId}`, ap !== undefined && view.status === 'paused' && now - ap.since >= this.cfg.autoPauseMs, now, {
        severity: 'warn', botId, ts: now, title: `${s}: pausado automaticamente`,
        text: `Motivo: ${ap?.reason ?? '?'} (há ${ap ? Math.round((now - ap.since) / 1000) : 0} s). O bot volta sozinho quando a condição passar.`,
      }, { severity: 'resolved', botId, ts: now, title: `${s}: voltou a cotar`, text: 'A pausa automática terminou.' }));

      const vh = this.venueHold.get(botId);
      out.push(...this.condition(`venue:${botId}`, vh !== undefined && !vh.reason.startsWith('fatal:') && now - vh.since >= this.cfg.autoPauseMs, now, {
        severity: 'warn', botId, ts: now, title: `${s}: live sem cotar`,
        text: `Motivo: ${vh?.reason ?? '?'} (há ${vh ? Math.round((now - vh.since) / 1000) : 0} s). Ordens canceladas; volta sozinho após reconciliar com a corretora.`,
      }, { severity: 'resolved', botId, ts: now, title: `${s}: live voltou a cotar`, text: 'Corretora reconciliada; cotando de novo.' }));

      const feedAge = view.feeds.mexcAgeMs;
      const feedDead = feedAge === null || feedAge > this.cfg.staleFeedMs;
      out.push(...this.condition(`feed:${botId}`, feedDead, now, {
        severity: 'critical', botId, ts: now, title: `${s}: feed da MEXC parado`,
        text: `Sem dados da corretora há ${feedAge === null ? '?' : Math.round(feedAge / 1000)} s. O bot pausa sozinho (fail-closed) até o feed voltar.`,
      }, { severity: 'resolved', botId, ts: now, title: `${s}: feed da MEXC de volta`, text: 'Dados da corretora normalizados.' }));

      const { equity, peakEquity } = view.pnl;
      const dd = equity !== null && peakEquity !== null && peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      out.push(...this.condition(`dd:${botId}`, dd >= this.cfg.drawdownWarn, now, {
        severity: 'warn', botId, ts: now, title: `${s}: drawdown ${pct(dd)}`,
        text: `Equity ${equity?.toFixed(4)} contra o pico de ${peakEquity?.toFixed(4)}. Os limites de risco do bot continuam valendo (halt automático).`,
      }, { severity: 'resolved', botId, ts: now, title: `${s}: drawdown abaixo de ${pct(this.cfg.drawdownWarn)}`, text: `Agora em ${pct(Math.max(0, dd))}.` }));
    }
    // Error bursts clear when the window empties.
    for (const [botId, ts] of this.errors) {
      const live = ts.filter((t) => t > now - this.cfg.errorWindowMs);
      this.errors.set(botId, live);
      if (live.length < this.cfg.errorBurst) {
        out.push(...this.condition(`errors:${botId}`, false, now, undefined, { severity: 'resolved', botId, ts: now, title: `${sym(botId)}: erros normalizados`, text: 'Menos erros na janela recente.' }));
      }
    }
    return out;
  }

  private condition(key: string, on: boolean, now: number, start?: Alert, end?: Alert): Alert[] {
    const c = this.active.get(key);
    if (on) {
      if (!c) {
        this.active.set(key, { since: now, lastAlert: now });
        return start ? [start] : [];
      }
      if (start && now - c.lastAlert >= this.cfg.repeatMs) {
        c.lastAlert = now;
        return [{ ...start, title: `${start.title} (ainda, há ${Math.round((now - c.since) / 60_000)} min)` }];
      }
      return [];
    }
    if (c) {
      this.active.delete(key);
      return end ? [end] : [];
    }
    return [];
  }
}

export interface DailyRow {
  botId: string;
  status: string;
  equity: number | null;
  equity24hAgo: number | null;
  fills24h: number;
  edgeN: number;
  edgeMeanBps: number;
}

/** The daily digest: one line per bot, plus totals. Honest about short histories. */
export function dailySummary(rows: DailyRow[], now: number): Alert {
  const lines = rows.map((r) => {
    const d = r.equity !== null && r.equity24hAgo !== null ? r.equity - r.equity24hAgo : null;
    const bps = d !== null && r.equity24hAgo ? (d / r.equity24hAgo) * 1e4 : null;
    return `**${sym(r.botId)}** · ${r.status} · 24h ${d === null ? 'sem histórico' : `${d >= 0 ? '+' : ''}${d.toFixed(4)} USDT (${bps!.toFixed(1)} bps)`} · ${r.fills24h} fills · edge n=${r.edgeN}, média ${r.edgeMeanBps.toFixed(2)} bps/h`;
  });
  const tot = rows.reduce((a, r) => (r.equity !== null && r.equity24hAgo !== null ? a + (r.equity - r.equity24hAgo) : a), 0);
  return {
    severity: 'info', botId: null, ts: now, title: 'Resumo diário da farm',
    text: `${lines.join('\n')}\n\nTotal 24h: ${tot >= 0 ? '+' : ''}${tot.toFixed(4)} USDT. Indicadores ao vivo, sem correção; GO/NO-GO só pelo avaliador oficial.`,
  };
}
