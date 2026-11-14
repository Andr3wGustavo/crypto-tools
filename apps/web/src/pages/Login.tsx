import { useEffect, useState } from 'react';
import { Logo } from '../components/Layout';
import { Button, cx } from '../components/ui';
import { api } from '../lib/api';
import { findPhantom, signInError, signInWithPhantom, type SignInStep } from '../lib/wallet';

const STEP_LABEL: Record<SignInStep, string> = {
  connect: 'Conectando a carteira…',
  challenge: 'Pedindo o desafio ao servidor…',
  sign: 'Assine a mensagem na Phantom…',
  verify: 'Verificando a assinatura…',
};

export function Login({ onSignedIn, expired }: { onSignedIn: () => void; expired?: boolean }) {
  const [phantom, setPhantom] = useState(() => findPhantom());
  const [step, setStep] = useState<SignInStep | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Phantom injects its provider shortly after load.
  useEffect(() => {
    if (phantom) return;
    const id = setInterval(() => {
      const p = findPhantom();
      if (p) {
        setPhantom(p);
        clearInterval(id);
      }
    }, 300);
    const stop = setTimeout(() => clearInterval(id), 4_000);
    return () => {
      clearInterval(id);
      clearTimeout(stop);
    };
  }, [phantom]);

  const go = async () => {
    if (!phantom) return;
    setError(null);
    try {
      await signInWithPhantom(phantom, api, window.location.host, setStep);
      onSignedIn();
    } catch (e) {
      setError(signInError(e));
    } finally {
      setStep(null);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass w-full max-w-md p-7 sm:p-8">
        <Logo />
        <h1 className="mt-7 text-xl font-bold tracking-tight">Console do operador</h1>
        <p className="mt-2 text-sm text-muted">
          Entre com a sua carteira Solana. Você assina uma mensagem de login: <strong className="text-ink">não é uma transação</strong>, não custa nada e
          não dá acesso aos seus fundos.
        </p>
        {expired && <p className="mt-4 rounded-[8px] border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">Sua sessão expirou. Entre de novo.</p>}
        <div className="mt-6">
          {phantom ? (
            <Button variant="primary" className="w-full py-3 text-base" onClick={() => void go()} disabled={step !== null}>
              {step ? STEP_LABEL[step] : 'Conectar Phantom'}
            </Button>
          ) : (
            <div className="rounded-[8px] border border-line bg-bg p-4 text-sm text-muted">
              <p className="font-semibold text-ink">Phantom não encontrada.</p>
              <p className="mt-1">No computador, instale a extensão Phantom. No celular, abra este endereço <em>dentro do navegador do app Phantom</em>.</p>
              <a className="mt-3 inline-block text-brand hover:underline" href="https://phantom.com/download" target="_blank" rel="noreferrer noopener">phantom.com/download ↗</a>
            </div>
          )}
        </div>
        {error && <p role="alert" className={cx('mt-4 rounded-[8px] border border-down/30 bg-down/10 px-3 py-2 text-sm text-down')}>{error}</p>}
        <ul className="mt-6 space-y-1.5 text-xs text-faint">
          <li>• Só carteiras autorizadas no servidor entram.</li>
          <li>• Pausar é um clique. Retomar e resetar pedem o código 2FA (TOTP).</li>
          <li>• Toda ação fica no log de auditoria.</li>
        </ul>
      </div>
    </div>
  );
}
