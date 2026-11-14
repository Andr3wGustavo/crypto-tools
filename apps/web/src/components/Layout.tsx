import { useState, type ReactNode } from 'react';
import type { Me } from '../lib/api';
import { shortAddr } from '../lib/format';
import type { ConnState } from '../lib/live';
import { hrefOf, type Route } from '../lib/router';
import { live, useLiveVersion, useServerNow, useViews } from '../state';
import { Dot, Link, Pill, cx, useToast } from './ui';

type NavItem = { route: Route; label: string; icon: string; mobile?: boolean };
export const NAV: NavItem[] = [
  { route: { page: 'overview' }, label: 'Visão geral', icon: '◈', mobile: true },
  { route: { page: 'risk' }, label: 'Risco', icon: '⛨', mobile: true },
  { route: { page: 'fills' }, label: 'Fills', icon: '⇄', mobile: true },
  { route: { page: 'logs' }, label: 'Logs', icon: '≡', mobile: true },
  { route: { page: 'treasury' }, label: 'Tesouro', icon: '◎' },
  { route: { page: 'system' }, label: 'Sistema', icon: '⌁' },
  { route: { page: 'settings' }, label: 'Ajustes', icon: '⚙' },
];

const CONN: Record<ConnState, { label: string; tone: 'up' | 'warn' | 'down' | 'neutral' }> = {
  idle: { label: 'Desconectado', tone: 'neutral' },
  connecting: { label: 'Conectando', tone: 'warn' },
  live: { label: 'Ao vivo', tone: 'up' },
  reconnecting: { label: 'Reconectando', tone: 'warn' },
  unauthorized: { label: 'Sessão expirada', tone: 'down' },
};

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden>
        <path d="M16 3l11 6.4v13.2L16 29 5 22.6V9.4z" fill="none" stroke="var(--color-brand)" strokeWidth="2.6" strokeLinejoin="round" />
        <circle cx="16" cy="16" r="3.6" fill="var(--color-brand)" />
      </svg>
      <span className="whitespace-nowrap text-[19px] font-bold tracking-tight text-brand">cortex<span className="text-ink">farm</span><span className="cursor-blink">_</span></span>
    </span>
  );
}

function WalletChip({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(me.actor);
      toast('Endereço copiado', 'brand');
    } catch {
      toast('Não foi possível copiar', 'warn');
    }
  };
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 whitespace-nowrap rounded-[8px] border border-line-strong bg-raised px-2.5 py-1.5 text-sm hover:border-brand/50">
        <span className="size-4 rounded-full bg-gradient-to-br from-[#9945FF] to-[#14F195]" aria-hidden />
        <span className="num">{shortAddr(me.actor)}</span>
      </button>
      {open && (
        <div className="glass absolute right-0 z-40 mt-2 w-60 border-line-strong p-1.5 text-sm" onMouseLeave={() => setOpen(false)}>
          <button type="button" className="w-full rounded-[6px] px-3 py-2 text-left hover:bg-raised" onClick={() => void copy()}>Copiar endereço</button>
          <a className="block rounded-[6px] px-3 py-2 hover:bg-raised" href={`https://solscan.io/account/${me.actor}`} target="_blank" rel="noreferrer noopener">Ver no Solscan ↗</a>
          <button type="button" className="w-full rounded-[6px] px-3 py-2 text-left text-down hover:bg-raised" onClick={onLogout}>Sair</button>
        </div>
      )}
    </div>
  );
}

/** Revert-style status bar: version and links on the left, live state on the right. */
function StatusBar({ me, conn }: { me: Me; conn: (typeof CONN)[ConnState] }) {
  const views = useViews();
  const now = useServerNow();
  const running = views.filter((v) => v.status === 'running').length;
  const version = views[0]?.version ?? 'n/a';
  const sep = 'border-l border-line px-3';
  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 hidden h-7 items-center justify-between border-t border-line bg-bg text-[11px] uppercase tracking-wide text-faint md:flex">
      <div className="flex h-full items-center">
        <span className="px-3">cortex v.{version}</span>
        <a className={cx(sep, 'hover:text-ink')} href="https://github.com/Andr3wGustavo/crypto-tools" target="_blank" rel="noreferrer noopener">github</a>
        <span className={sep}>shadow-first · maker 0%</span>
      </div>
      <div className="flex h-full items-center">
        <span className="flex items-center gap-1.5 px-3">bots <Dot tone={running === views.length && views.length > 0 ? 'up' : 'warn'} /> <span className="num text-ink">{running}/{views.length}</span></span>
        <span className={cx(sep, 'flex items-center gap-1.5')}>feed <Dot tone={conn.tone} pulse={live.state === 'live'} /> <span className="text-ink">{conn.label}</span></span>
        <span className={cx(sep, 'num')}>{new Date(now).toISOString().slice(11, 19)} utc</span>
        <span className={cx(sep, 'num')}>{shortAddr(me.actor)}</span>
      </div>
    </footer>
  );
}

export function Layout({ route, me, onLogout, children }: { route: Route; me: Me; onLogout: () => void; children: ReactNode }) {
  useLiveVersion();
  const conn = CONN[live.state];
  const active = (r: Route) => r.page === route.page || (route.page === 'bot' && r.page === 'overview');
  return (
    <div className="min-h-dvh pb-24 md:pb-14">
      <header data-conn={live.state} className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="shrink-0"><Logo /></Link>
          <nav className="hidden flex-1 items-center gap-0.5 md:flex" aria-label="Principal">
            {NAV.map((n) => (
              <Link key={n.label} href={hrefOf(n.route)}
                className={cx('rounded-[6px] px-2.5 py-1.5 text-[13px] font-semibold uppercase tracking-wide transition-colors lg:px-3', active(n.route) ? 'bg-raised text-brand' : 'text-ink/80 hover:text-white')}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {/* Wrappers carry the responsive visibility: a Pill's own inline-flex would override `hidden`. */}
            <span className="sm:hidden" title={conn.label}><Dot tone={conn.tone} pulse={live.state === 'live'} /></span>
            <span className="hidden sm:inline"><Pill tone={conn.tone}><Dot tone={conn.tone} pulse={live.state === 'live'} />{conn.label}</Pill></span>
            <span className="hidden lg:inline"><Pill tone="brand">SHADOW</Pill></span>
            <WalletChip me={me} onLogout={onLogout} />
          </div>
        </div>
      </header>
      {live.state !== 'live' && live.state !== 'idle' && (
        <div className={cx('border-b px-4 py-1.5 text-center text-xs font-semibold', conn.tone === 'down' ? 'border-down/30 bg-down/10 text-down' : 'border-warn/30 bg-warn/10 text-warn')}>
          {conn.label}… os números abaixo podem estar desatualizados.
        </div>
      )}
      <main className="mx-auto max-w-[1440px] px-4 pt-6 sm:px-6">{children}</main>
      <StatusBar me={me} conn={conn} />
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="Navegação">
        <div className="grid grid-cols-5">
          {NAV.filter((n) => n.mobile).map((n) => (
            <Link key={n.label} href={hrefOf(n.route)} className={cx('flex flex-col items-center gap-0.5 py-2 text-[10px] uppercase tracking-wide', active(n.route) ? 'text-brand' : 'text-muted')}>
              <span className="text-lg leading-none" aria-hidden>{n.icon}</span>{n.label}
            </Link>
          ))}
          <Link href="/system" className={cx('flex flex-col items-center gap-0.5 py-2 text-[10px] uppercase tracking-wide', ['system', 'settings', 'treasury'].includes(route.page) ? 'text-brand' : 'text-muted')}>
            <span className="text-lg leading-none" aria-hidden>⋯</span>Mais
          </Link>
        </div>
      </nav>
    </div>
  );
}
