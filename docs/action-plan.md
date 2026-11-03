# Plano de Ação: Auto-Farm AFK — Resumo Executivo

## O que foi feito até agora

### Implementação (código real, testável)
1. **Testnet support** — `BINANCE_TESTNET=true` redireciona para testnet.binance.vision. Sem risco real.
2. **Avellaneda-Stoikov quoting** — reservation price, spread ótimo δ*, fill intensity. Substitui spread heurístico.
3. **Volatility targeting** — `f_i = (σ_target/σ_i) × f_base` com EWMA (λ=0.94). Cap 2x.
4. **Edge Estimator (NIG)** — Normal-Inverse-Gamma sobre PnL em bps. Gate: P(μ>0) > 0.95.
5. **Fill Ledger** — persiste fills com fees reais. Calcula PnL de round-trip em quote e bps.
6. **Reconciler** — no boot: cancela ordens, reconcilia saldos/fills, loga capital state.
7. **Compound (fechado)** — persiste capital no SQLite. Split reinvest/reserva. Cap + drawdown limit + halt.
8. **Auto-Withdraw (profit skimming)** — quando reserva protegida ≥ threshold, envia lucro para carteira (Solana transfer ou Binance withdraw). Reset reserva.
9. **User Stream (integrado)** — pairing buy/sell por orderId. Realiza PnL. Atualiza edge + compound + order size + skim trigger.
10. **Discord /compound** — comando mostra capital, profit, drawdown, edge, shouldTrade.
11. **/mm status** — agora mostra sigma, order size, edge prob, shouldTrade.
12. **Heartbeat** — log a cada 60s com capital, profit, drawdown, edge.
13. **PM2 config** — `ecosystem.config.js` para AFK (auto-restart, max memory, logs).

### Documentação
- `docs/status.md` — checklist completo + análise matemática.
- `docs/auto-farm-afk.md` — lógica, fórmulas, arquitetura, insights da segunda IA.
- `docs/action-plan.md` — este arquivo (resumo de ação).

---

## O que devemos fazer agora (ordem de prioridade)

### Passo 1 — Testar em testnet (AGORA)
1. Obter chaves de testnet: https://testnet.binance.vision/
2. Configurar `.env`:
   ```
   BINANCE_TESTNET=true
   BINANCE_API_KEY=<testnet key>
   BINANCE_SECRET=<testnet secret>
   MM_SYMBOL=BTCUSDT
   MM_MIN_ORDER_USD=5
   ```
3. Rodar: `npm run dev`
4. Observar logs por 1–3 dias. Coletar dados.

### Passo 2 — Analisar resultados
- Edge real? (`P(μ>0) > 0.95`?)
- Fill rate? (quantos % das ordens executam?)
- Drawdown? (capital caiu mais de 15%?)
- Compound funcionou? (capital cresceu?)
- Se edge negativo → o framework te disse a verdade. Não ir live.

### Passo 3 — Se edge positivo confirmado
- Ir live com $25–$50 (não $1).
- Monitorar drawdown e edge continuamente.
- Ajustar parâmetros (γ, k, σ_target) conforme dados.

### Passo 4 — Evoluções futuras (quando estável)
1. **Multi-pair** — distribuir capital entre N pares (com correlação real).
2. **Grid multicamadas** — capturar flash wicks (MM_GRID_LEVELS).
3. **Sniper DEX (Solana)** — auto-buy com carteira burner + Jupiter tx.
4. **Capital Bootstrap** — fase 0→1→2→3 (paper → real).
5. **Risk Manager (IA)** — drawdown limit, kill switch, halt automático.
6. **AFK infra** — PM2/Docker, auto-restart, backup, IP whitelist.
7. **Testes + CI** — evitar regressão no PnL.

---

## Regra de ouro

> **Não ir live até P(μ>0) > 0.95 em testnet com pelo menos 300 round-trips.**  
> O framework vai te dizer a verdade. Se não tiver edge, não perca dinheiro real.

---

## Configuração de Auto-Withdraw (profit skimming)

```env
# Threshold para disparar retirada (em USD)
WITHDRAW_THRESHOLD=0.5

# Destino da retirada (Solana pubkey ou endereço Binance)
WITHDRAW_DESTINATION=<sua carteira>

# Asset a retirar (USDT, SOL, BTC, etc.)
WITHDRAW_ASSET=USDT
```

Modos suportados:
- **Solana:** Se `SOLANA_PRIVATE_KEY` configurado, transfere via @solana/web3.js.
- **Binance:** Se apenas API keys configuradas, usa withdraw API da Binance.
- **Desabilitado:** Se nenhum configurado, skimming é desabilitado (lucro acumula na reserva).

## Comandos úteis

| Comando | Descrição |
|---|---|
| `npm run dev` | Rodar em desenvolvimento (hot-reload) |
| `npm run build` | Compilar TypeScript |
| `npm start` | Rodar produção |
| `pm2 start ecosystem.config.js` | Rodar AFK com PM2 (auto-restart) |
| `npm run db:push` | Sincronizar schema SQLite |
| `/mm status` | Status do market maker (Discord) |
| `/compound` | Stats de capital, edge e withdraw (Discord) |
| `/gains` | Posições ativas e PnL (Discord) |

---

## Arquivos-chave

| Arquivo | Função |
|---|---|
| `src/modules/trading/market-maker.engine.ts` | Motor de market making (Avellaneda-Stoikov, vol-targeting) |
| `src/modules/trading/edge-estimator.service.ts` | Estimador de edge (Normal-Inverse-Gamma) |
| `src/modules/trading/fill-ledger.service.ts` | Ledger de fills e PnL de round-trip |
| `src/modules/trading/compound.service.ts` | Compound com persistência, cap, drawdown |
| `src/modules/trading/reconciler.service.ts` | Reconciliação no boot |
| `src/modules/trading/binance-user-stream.service.ts` | Captura fills, pairing buy/sell, compound |
| `src/config/env.ts` | Configuração (testnet, compound, etc.) |
| `docs/auto-farm-afk.md` | Documentação completa (lógica, fórmulas, arquitetura) |
| `docs/status.md` | Checklist de milestones e pendências |
| `docs/action-plan.md` | Este arquivo (resumo de ação) |
