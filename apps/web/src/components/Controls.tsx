import type { BotView, EngineCommandName } from '@cortex/shared';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { Button, Modal, useToast } from './ui';

const LABEL: Record<EngineCommandName, string> = { pause: 'Pausar', resume: 'Retomar', reset_halt: 'Resetar halt', reset_kill: 'Resetar kill' };
const RISKY = new Set<EngineCommandName>(['resume', 'reset_halt', 'reset_kill']);

/** Which commands make sense in each state (the engine also ignores no-ops). */
export function availableCommands(v: BotView): EngineCommandName[] {
  switch (v.status) {
    case 'running':
      return ['pause'];
    case 'paused':
      return ['resume'];
    case 'halted':
      return ['pause', 'reset_halt'];
    case 'killed':
      return ['reset_kill'];
  }
}

export async function sendCommand(botId: string, c: EngineCommandName, totp?: string): Promise<string> {
  try {
    await api.command(botId, c, totp);
    return `${LABEL[c]}: enviado. O worker aplica e confirma no log.`;
  } catch (e) {
    const err = e as ApiError;
    if (err.status === 403 && err.message === 'totp required') throw new Error('Código 2FA inválido ou já usado. Espere o próximo código.');
    if (err.status === 503) throw new Error('Barramento de comandos indisponível (Redis). Nada foi enviado.');
    throw new Error(`Falhou: ${err.message}`);
  }
}

/**
 * Bot controls. Pausing is one click, always. Anything that can increase risk asks for a fresh
 * TOTP code (the API enforces it; this only collects it).
 */
export function Controls({ v }: { v: BotView }) {
  const toast = useToast();
  const [pending, setPending] = useState<EngineCommandName | null>(null);
  const [ask, setAsk] = useState<EngineCommandName | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const run = async (c: EngineCommandName, totp?: string) => {
    setPending(c);
    setErr(null);
    try {
      toast(await sendCommand(v.botId, c, totp), 'brand');
      setAsk(null);
      setCode('');
    } catch (e) {
      const m = (e as Error).message;
      if (totp !== undefined) setErr(m);
      else toast(m, 'down');
    } finally {
      setPending(null);
    }
  };

  const cmds = availableCommands(v);
  return (
    <div className="flex flex-wrap gap-2">
      {cmds.map((c) => (
        <Button key={c} variant={c === 'pause' ? 'danger' : 'ghost'} disabled={pending !== null}
          onClick={() => (RISKY.has(c) ? (setAsk(c), setErr(null)) : void run(c))}>
          {pending === c ? '…' : LABEL[c]}{RISKY.has(c) && <span className="text-[10px] text-faint">2FA</span>}
        </Button>
      ))}
      <Modal open={ask !== null} onClose={() => setAsk(null)} title={ask ? `${LABEL[ask]} · confirmação 2FA` : ''}>
        <form onSubmit={(e) => {
          e.preventDefault();
          if (ask && /^\d{6}$/.test(code)) void run(ask, code);
        }}>
          <p className="text-sm text-muted">Esta ação pode aumentar o risco. Digite o código de 6 dígitos do seu app autenticador.</p>
          <input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="num mt-4 w-full rounded-[8px] border border-line-strong bg-bg px-4 py-3 text-center text-2xl tracking-[0.5em] outline-none focus:border-brand"
            aria-label="Código 2FA" />
          {err && <p role="alert" className="mt-3 text-sm text-down">{err}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="subtle" onClick={() => setAsk(null)}>Cancelar</Button>
            <Button type="submit" variant="primary" disabled={code.length !== 6 || pending !== null}>{pending ? 'Enviando…' : 'Confirmar'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
