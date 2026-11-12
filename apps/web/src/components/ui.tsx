import type { BotStatusName } from '@cortex/shared';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { onLinkClick } from '../lib/router';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export function Link({ href, className, children, title }: { href: string; className?: string; children: ReactNode; title?: string }) {
  return (
    <a href={href} className={className} title={title} onClick={(e) => onLinkClick(e, href)}>
      {children}
    </a>
  );
}

export function Card({ title, action, className, children, pad = true }: { title?: ReactNode; action?: ReactNode; className?: string; children: ReactNode; pad?: boolean }) {
  return (
    <section className={cx('glass', pad && 'p-4 sm:p-5', className)}>
      {(title || action) && (
        <header className={cx('mb-3 flex items-center justify-between gap-3', !pad && 'px-4 pt-4 sm:px-5')}>
          {title && <h2 className="label">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export type Tone = 'neutral' | 'up' | 'down' | 'warn' | 'brand' | 'info';
const toneText: Record<Tone, string> = { neutral: 'text-ink', up: 'text-up', down: 'text-down', warn: 'text-warn', brand: 'text-brand', info: 'text-info' };
export const toneOf = (x: number | null | undefined): Tone => (x === null || x === undefined || x === 0 || !Number.isFinite(x) ? 'neutral' : x > 0 ? 'up' : 'down');

export function Stat({ label, value, sub, tone = 'neutral', hint }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; hint?: string }) {
  return (
    <div className="glass p-4" title={hint}>
      <div className="label">{label}</div>
      <div className={cx('num mt-1.5 text-2xl font-semibold tracking-tight sm:text-[28px]', toneText[tone])}>{value}</div>
      {sub && <div className="num mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Pill({ children, tone = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  const map: Record<Tone, string> = {
    neutral: 'border-line-strong bg-raised text-muted',
    up: 'border-up/30 bg-up/10 text-up',
    down: 'border-down/30 bg-down/10 text-down',
    warn: 'border-warn/30 bg-warn/10 text-warn',
    brand: 'border-brand/40 bg-brand/10 text-brand',
    info: 'border-info/30 bg-info/10 text-info',
  };
  return <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium', map[tone], className)}>{children}</span>;
}

const STATUS: Record<BotStatusName, { label: string; tone: Tone }> = {
  running: { label: 'Cotando', tone: 'up' },
  paused: { label: 'Pausado', tone: 'warn' },
  halted: { label: 'Halt', tone: 'down' },
  killed: { label: 'Kill', tone: 'down' },
};

export function StatusBadge({ status, quoting, stale }: { status: BotStatusName; quoting?: boolean; stale?: boolean }) {
  if (stale) return <Pill tone="down"><Dot tone="down" /> Sem dados</Pill>;
  const s = STATUS[status];
  const label = status === 'running' && quoting === false ? 'Ativo, sem cotar' : s.label;
  return (
    <Pill tone={status === 'running' && quoting === false ? 'warn' : s.tone}>
      <Dot tone={s.tone} pulse={status === 'running' && quoting !== false} /> {label}
    </Pill>
  );
}

export function Dot({ tone = 'neutral', pulse }: { tone?: Tone; pulse?: boolean }) {
  const bg: Record<Tone, string> = { neutral: 'bg-faint', up: 'bg-up', down: 'bg-down', warn: 'bg-warn', brand: 'bg-brand', info: 'bg-info' };
  return <span aria-hidden className={cx('inline-block size-1.5 rounded-full', bg[tone], pulse && 'pulse-dot')} />;
}

export function Button({ children, onClick, variant = 'ghost', disabled, type = 'button', className, title }: {
  children: ReactNode; onClick?: () => void; variant?: 'primary' | 'ghost' | 'danger' | 'subtle'; disabled?: boolean; type?: 'button' | 'submit'; className?: string; title?: string;
}) {
  const v = {
    primary: 'bg-brand text-black hover:bg-[#ffe14d] glow',
    ghost: 'border border-line-strong bg-raised text-ink hover:border-brand/50 hover:text-brand',
    danger: 'border border-down/40 bg-down/15 text-down hover:bg-down/25',
    subtle: 'text-muted hover:text-ink',
  }[variant];
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick}
      className={cx('inline-flex min-h-9 items-center justify-center gap-2 rounded-xl px-3.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40', v, className)}>
      {children}
    </button>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden />;
}

export function Empty({ title, children, icon = '◇' }: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="text-2xl text-brand/70" aria-hidden>{icon}</div>
      <div className="font-semibold">{title}</div>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose}
      className="m-auto w-[min(92vw,420px)] rounded-2xl border border-line bg-surface p-0 text-ink backdrop:bg-black/70 backdrop:backdrop-blur-sm">
      <div className="p-5">
        <h3 className="mb-3 text-base font-semibold">{title}</h3>
        {children}
      </div>
    </dialog>
  );
}

type Toast = { id: number; text: string; tone: Tone };
const ToastCtx = createContext<(text: string, tone?: Tone) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, tone: Tone = 'neutral') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5_000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6">
        {toasts.map((t) => (
          <div key={t.id} className={cx('glass pointer-events-auto max-w-md px-4 py-2.5 text-sm', toneText[t.tone])}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Small key/value row used by the detail panels. */
export function KV({ k, v, tone = 'neutral', hint }: { k: ReactNode; v: ReactNode; tone?: Tone; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1.5 last:border-0" title={hint}>
      <span className="text-sm text-muted">{k}</span>
      <span className={cx('num text-sm', toneText[tone])}>{v}</span>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-xl border border-line bg-raised p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={cx('rounded-[10px] px-2.5 py-1 text-xs font-semibold transition-colors', value === o.value ? 'bg-brand text-black' : 'text-muted hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
