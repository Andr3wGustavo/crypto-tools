import { useState, type ReactNode } from 'react';
import type { Me } from '../lib/api';
import { shortAddr } from '../lib/format';
import type { ConnState } from '../lib/live';
import { hrefOf, type Route } from '../lib/router';
import { live, useLiveVersion } from '../state';
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
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
        <path d="M16 3l11 6.4v13.2L16 29 5 22.6V9.4z" fill="none" stroke="#FFD60A" strokeWidth="2.4" strokeLinejoin="round" />
        <circle cx="16" cy="16" r="3.6" fill="#FFD60A" />
      </svg>
      <span className="whitespace-nowrap text-[15px] font-extrabold tracking-[0.18em]">CORTEX<span className="text-brand">·</span>FARM</span>
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
        className="flex items-center gap-2 whitespace-nowrap rounded-xl border border-line-strong bg-raised px-2.5 py-1.5 text-sm hover:border-brand/50">
        <span className="size-5 rounded-full bg-gradient-to-br from-brand to-[#ff8a00]" aria-hidden />
        <span className="num">{shortAddr(me.actor)}</span>
      </button>
      {open && (
        <div className="glass absolute right-0 z-40 mt-2 w-60 p-2 text-sm" onMouseLeave={() => setOpen(false)}>
          <button type="button" className="w-full rounded-lg px-3 py-2 text-left hover:bg-raised" onClick={() => void copy()}>Copiar endereço</button>
          <a className="block rounded-lg px-3 py-2 hover:bg-raised" href={`https://solscan.io/account/${me.actor}`} target="_blank" rel="noreferrer noopener">Ver no Solscan ↗</a>
          <button type="button" className="w-full rounded-lg px-3 py-2 text-left text-down hover:bg-raised" onClick={onLogout}>Sair</button>
        </div>
      )}
    </div>
  );
}

export function Layout({ route, me, onLogout, children }: { route: Route; me: Me; onLogout: () => void; children: ReactNode }) {
  useLiveVersion();
  const conn = CONN[live.state];
  const active = (r: Route) => r.page === route.page || (route.page === 'bot' && r.page === 'overview');
  return (
    <div className="min-h-dvh pb-24 md:pb-10">
      <header data-conn={live.state} className="sticky top-0 z-30 border-b border-line/70 bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4 sm:px-6">
          <Link href="/" className="shrink-0"><Logo /></Link>
          <nav className="hidden flex-1 items-center gap-1 md:flex" aria-label="Principal">
            {NAV.map((n) => (
              <Link key={n.label} href={hrefOf(n.route)}
                className={cx('rounded-lg px-3 py-1.5 text-sm font-medium transition-colors', active(n.route) ? 'bg-raised text-brand' : 'text-muted hover:text-ink')}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {/* Wrappers carry the responsive visibility: a Pill's own inline-flex would override `hidden`. */}
            <span className="sm:hidden" title={conn.label}><Dot tone={conn.tone} pulse={live.state === 'live'} /></span>
            <span className="hidden sm:inline"><Pill tone={conn.tone}><Dot tone={conn.tone} pulse={live.state === 'live'} />{conn.label}</Pill></span>
            <span className="hidden lg:inline"><Pill tone="brand">SHADOW</Pill></span>
            <span className="hidden lg:inline"><Pill><span className="size-1.5 rounded-full bg-gradient-to-r from-[#9945FF] to-[#14F195]" />Solana</Pill></span>
            <WalletChip me={me} onLogout={onLogout} />
          </div>
        </div>
      </header>
      {live.state !== 'live' && live.state !== 'idle' && (
        <div className={cx('border-b px-4 py-1.5 text-center text-xs', conn.tone === 'down' ? 'border-down/30 bg-down/10 text-down' : 'border-warn/30 bg-warn/10 text-warn')}>
          {conn.label}… os números abaixo podem estar desatualizados.
        </div>
      )}
      <main className="mx-auto max-w-[1400px] px-4 pt-5 sm:px-6">{children}</main>
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden" aria-label="Navegação">
        <div className="grid grid-cols-5">
          {NAV.filter((n) => n.mobile).map((n) => (
            <Link key={n.label} href={hrefOf(n.route)} className={cx('flex flex-col items-center gap-0.5 py-2 text-[11px]', active(n.route) ? 'text-brand' : 'text-muted')}>
              <span className="text-lg leading-none" aria-hidden>{n.icon}</span>{n.label}
            </Link>
          ))}
          <Link href="/system" className={cx('flex flex-col items-center gap-0.5 py-2 text-[11px]', ['system', 'settings', 'treasury'].includes(route.page) ? 'text-brand' : 'text-muted')}>
            <span className="text-lg leading-none" aria-hidden>⋯</span>Mais
          </Link>
        </div>
      </nav>
    </div>
  );
}
