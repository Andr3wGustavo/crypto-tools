import type { BotView, TreasuryView } from '@cortex/shared';
import { useEffect, useState } from 'react';
import { Card, KV, Pill, Stat, toneOf, type Tone } from '../components/ui';
import { totalsOf } from '../lib/derive';
import { DASH, botSymbol, fmtBps, fmtDateTime, fmtUsd, shortAddr } from '../lib/format';
import { solscanAccount, solscanTx, usdtBalance } from '../lib/solana';
import { useServerNow, useViews } from '../state';

const LADDER = [
  { id: 'D0', label: 'Shadow', capital: 'US$ 0 (simulado)', gate: 'GO no protocolo pré-registrado' },
  { id: 'D1', label: 'Live mínimo', capital: 'US$ 15', gate: 'loss budget US$ 3; live coerente com o shadow' },
  { id: 'D2', label: 'Escala 1', capital: 'US$ 50', gate: 'edge confirmado no live' },
  { id: 'D3', label: 'Escala 2', capital: 'US$ 200+', gate: 'idem, com drawdown dentro do limite' },
];

const WD_LABEL: Record<string, { text: string; tone: Tone }> = {
  PENDING: { text: 'reservado', tone: 'warn' },
  SENT: { text: 'enviado', tone: 'info' },
  CONFIRMED: { text: 'confirmado', tone: 'up' },
  FAILED: { text: 'falhou', tone: 'down' },
};

/**
 * Cash & Treasury. Honest about the phase: in shadow there is no real cash, no treasury wallet
 * and no withdrawal. With a live bot it shows the three buckets from the engine's exact ledger,
 * the withdrawals (with Solscan links) and the on-chain wallet balance (public Solana RPC).
 */
export function Treasury() {
  const views = useViews();
  const live = views.filter((v): v is BotView & { treasury: TreasuryView } => v.mode === 'live' && !!v.treasury);
  return live.length > 0 ? <LiveTreasury views={live} /> : <ShadowTreasury views={views} />;
}

function Ladder({ current }: { current: number }) {
  return (
    <Card title="Escada de capital">
      <ol className="grid gap-3 md:grid-cols-4">
        {LADDER.map((d, i) => (
          <li key={d.id} className={i === current ? 'glass glow p-4' : 'rounded-[10px] border border-line bg-bg p-4 opacity-70'}>
            <div className="flex items-center justify-between"><span className="num text-lg font-bold">{d.id}</span>{i === current && <Pill tone="brand">atual</Pill>}</div>
            <div className="mt-1 font-semibold">{d.label}</div>
            <div className="num mt-1 text-sm text-muted">{d.capital}</div>
            <div className="mt-2 text-xs text-faint">Para subir: {d.gate}</div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function ShadowTreasury({ views }: { views: BotView[] }) {
  const t = totalsOf(views, useServerNow());
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Caixa e Tesouro</h1>
        <p className="text-sm text-muted">Fase atual: <strong className="text-brand">D0 · shadow</strong>. Nenhum dinheiro real está em jogo.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Capital simulado" value={fmtUsd(t.startEquity)} sub="soma dos bots" />
        <Stat label="Equity simulado" value={fmtUsd(t.equity)} />
        <Stat label="Resultado" value={fmtUsd(t.pnl, true)} tone={toneOf(t.pnl)} sub={fmtBps(t.pnlBps, 1, true)} />
        <Stat label="Tesouro on-chain" value={DASH} sub="só com um bot live" />
      </div>
      <Ladder current={0} />
      <Card title="Saque automático: as 5 travas (prontas, aguardando o live)">
        <KV k="Chave separada, só de saque, com IP vinculado (processo próprio)" v="exigida ao iniciar o withdrawer" tone="info" />
        <KV k="Destino: só a carteira tesouro Solana da whitelist da MEXC" v="exigido ao iniciar e a cada saque" tone="info" />
        <KV k="Mínimo max(US$ 20, mínimo da rede + taxa), 1 por dia, teto diário" v="motor + withdrawer + histórico MEXC" tone="info" />
        <KV k="Só lucro confirmado contra o equity real" v="ativo no motor live" tone="info" />
        <KV k="Nunca em shadow, halt, drawdown ou reconciliação pendente" v="ativo: shadow bloqueia" tone="up" />
      </Card>
    </div>
  );
}

function useWalletBalance(address: string | null): number | null | undefined {
  const [bal, setBal] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (!address) return;
    let alive = true;
    const load = () => usdtBalance(address).then((b) => {
      if (alive) setBal(b);
    });
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [address]);
  return address ? bal : null;
}

function LiveTreasury({ views }: { views: Array<BotView & { treasury: TreasuryView }> }) {
  const sum = (f: (t: TreasuryView) => number) => views.reduce((a, v) => a + f(v.treasury), 0);
  const wallet = views.find((v) => v.treasury.wallet)?.treasury.wallet ?? null;
  const onchain = useWalletBalance(wallet);
  const withdrawals = views.flatMap((v) => v.treasury.withdrawals.map((w) => ({ ...w, botId: v.botId }))).sort((a, b) => b.createdTs - a.createdTs);
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Caixa e Tesouro</h1>
        <p className="text-sm text-muted">Fase atual: <strong className="text-brand">D1 · live</strong>. Metade do lucro confirmado vai para o tesouro, que nunca opera.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Caixa (opera)" value={fmtUsd(sum((t) => t.cash))} sub={`principal ${fmtUsd(sum((t) => t.principal ?? 0))}`} />
        <Stat label="Tesouro (protegido)" value={fmtUsd(sum((t) => t.treasury))} tone={toneOf(sum((t) => t.treasury))} />
        <Stat label="Em saque" value={fmtUsd(sum((t) => t.withdrawing))} tone={sum((t) => t.withdrawing) > 0 ? 'warn' : 'neutral'} />
        <Stat label="Já sacado (líquido)" value={fmtUsd(sum((t) => t.withdrawn))} sub={`lucro protegido total ${fmtUsd(sum((t) => t.skimmed))}`} />
        <Stat
          label="Carteira tesouro on-chain"
          value={wallet ? (onchain === undefined ? '…' : onchain === null ? DASH : fmtUsd(onchain)) : DASH}
          sub={wallet ? <a className="underline" href={solscanAccount(wallet)} target="_blank" rel="noreferrer noopener">{shortAddr(wallet)} · Solscan</a> : 'WITHDRAW_ADDRESS não configurado'}
        />
      </div>
      <Ladder current={1} />
      <Card title="Saques">
        {withdrawals.length === 0 ? (
          <p className="text-sm text-muted">Nenhum saque ainda. O primeiro sai quando o tesouro passar de US$ 20 e todas as travas estiverem liberadas.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-faint"><tr><th className="py-1">Quando</th><th>Bot</th><th>Valor</th><th>Taxa</th><th>Status</th><th>Tx</th></tr></thead>
              <tbody>
                {withdrawals.map((w) => (
                  <tr key={`${w.botId}|${w.id}`} className="border-t border-line/50">
                    <td className="num py-1.5">{fmtDateTime(w.createdTs)}</td>
                    <td>{botSymbol(w.botId)}</td>
                    <td className="num">{fmtUsd(w.amount)}</td>
                    <td className="num">{w.fee === null ? DASH : fmtUsd(w.fee)}</td>
                    <td><Pill tone={WD_LABEL[w.status]?.tone ?? 'neutral'}>{WD_LABEL[w.status]?.text ?? w.status}</Pill>{w.reason && <span className="ml-2 text-xs text-faint">{w.reason}</span>}</td>
                    <td>{w.txId ? <a className="underline" href={solscanTx(w.txId)} target="_blank" rel="noreferrer noopener">{shortAddr(w.txId, 6, 6)}</a> : DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="As 5 travas do saque (agora)">
        {views.map((v) => {
          const eq = v.pnl.equity;
          const profitOk = eq !== null && v.treasury.principal !== null && eq >= v.treasury.principal;
          const healthy = v.status === 'running' && v.quoting;
          const inFlight = v.treasury.withdrawals.some((w) => w.status === 'PENDING' || w.status === 'SENT');
          return (
            <div key={v.botId} className="space-y-1">
              <div className="text-xs font-semibold text-muted">{botSymbol(v.botId)}</div>
              <KV k="1 · Chave só de saque, IP vinculado, processo separado" v="verificada pelo withdrawer ao iniciar" tone="info" />
              <KV k="2 · Destino: só a carteira tesouro da whitelist" v={v.treasury.wallet ? shortAddr(v.treasury.wallet) : 'não configurada'} tone={v.treasury.wallet ? 'up' : 'warn'} />
              <KV k="3 · Mínimo, 1 por dia e teto diário" v={inFlight ? 'um saque em andamento' : `tesouro ${fmtUsd(v.treasury.treasury)} (mín. US$ 20)`} tone={v.treasury.treasury >= 20 && !inFlight ? 'up' : 'neutral'} />
              <KV k="4 · Só lucro confirmado (equity ≥ principal)" v={profitOk ? 'ok' : 'bloqueado'} tone={profitOk ? 'up' : 'warn'} />
              <KV k="5 · Sem halt, drawdown ou reconciliação pendente" v={healthy ? 'liberado' : `bloqueado (${v.status}${v.quoting ? '' : ', sem cotar'})`} tone={healthy ? 'up' : 'warn'} />
            </div>
          );
        })}
      </Card>
    </div>
  );
}
