import { Card, KV, Pill, Stat, toneOf } from '../components/ui';
import { totalsOf } from '../lib/derive';
import { fmtBps, fmtUsd } from '../lib/format';
import { useServerNow, useViews } from '../state';

const LADDER = [
  { id: 'D0', label: 'Shadow', capital: 'US$ 0 (simulado)', gate: 'GO no protocolo pré-registrado' },
  { id: 'D1', label: 'Live mínimo', capital: 'US$ 15', gate: 'loss budget US$ 3; live coerente com o shadow' },
  { id: 'D2', label: 'Escala 1', capital: 'US$ 50', gate: 'edge confirmado no live' },
  { id: 'D3', label: 'Escala 2', capital: 'US$ 200+', gate: 'idem, com drawdown dentro do limite' },
];

/**
 * Cash & Treasury. Honest about the phase: in shadow there is no real cash, no treasury
 * wallet and no withdrawal. The on-chain part (wallet balance via RPC, withdrawals with Solscan
 * links, the 5 locks) lands with E9 auto-withdraw.
 */
export function Treasury() {
  const views = useViews();
  const t = totalsOf(views, useServerNow());
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Caixa e Tesouro</h1>
        <p className="text-sm text-muted">Fase atual: <strong className="text-brand">D0 · shadow</strong>. Nenhum dinheiro real está em jogo.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Capital simulado" value={fmtUsd(t.startEquity)} sub="soma dos bots" />
        <Stat label="Equity simulado" value={fmtUsd(t.equity)} />
        <Stat label="Resultado" value={fmtUsd(t.pnl, true)} tone={toneOf(t.pnl)} sub={fmtBps(t.pnlBps, 1, true)} />
        <Stat label="Tesouro on-chain" value="—" sub="chega na E9" />
      </div>
      <Card title="Escada de capital">
        <ol className="grid gap-3 md:grid-cols-4">
          {LADDER.map((d, i) => (
            <li key={d.id} className={i === 0 ? 'glass glow p-4' : 'rounded-2xl border border-line p-4 opacity-70'}>
              <div className="flex items-center justify-between"><span className="num text-lg font-bold">{d.id}</span>{i === 0 && <Pill tone="brand">atual</Pill>}</div>
              <div className="mt-1 font-semibold">{d.label}</div>
              <div className="num mt-1 text-sm text-muted">{d.capital}</div>
              <div className="mt-2 text-xs text-faint">Para subir: {d.gate}</div>
            </li>
          ))}
        </ol>
      </Card>
      <Card title="Auto-withdraw (E9): as 5 travas">
        <KV k="Chave separada, só de saque, com IP vinculado" v="pendente" tone="warn" />
        <KV k="Destino só para a carteira tesouro na whitelist" v="pendente" tone="warn" />
        <KV k="Mínimo max(US$ 20, taxa da rede) e 1 saque por dia" v="pendente" tone="warn" />
        <KV k="Só lucro confirmado contra o equity real" v="pendente" tone="warn" />
        <KV k="Nunca em shadow, halt, drawdown ou reconciliação pendente" v="ativo: shadow bloqueia" tone="up" />
      </Card>
    </div>
  );
}
