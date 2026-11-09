# Cortex Crypto Sentinel — Contexto Completo (Handoff para Claude no VSCode)

> Este arquivo consolida toda a conversa, planos, lógica e decisões tomadas durante o desenvolvimento do projeto.
> Destinado ao Claude no VSCode para ter contexto completo.

---

## 1. O Projeto

**Nome:** Cortex Crypto Sentinel (crypto-tools)
**Repo:** https://github.com/Andr3wGustavo/crypto-tools
**Path:** `A:\Dropbox\DEV-AI\Discord-Cortex\!FIAT-FARM\Crypto`
**Stack:** TypeScript, Node.js, Prisma + SQLite, Discord.js v14, Binance API, Gemini AI

**O que faz:** Infraestrutura modular para inteligência e trading cripto automatizado (AFK).
- Scout DEX (DexScreener), segurança (GoPlus/RugCheck), filtros heurísticos
- IA Due Diligence (Gemini/Claude configurável), RAG com embeddings
- Market Maker adaptativo na Binance (WebSocket, Avellaneda-Stoikov)
- Compound engine (reinvest + profit skimming + auto-withdraw)
- Gain Tracker (trailing stop, marcos 2x/5x/10x)
- Terminal Discord (8 comandos + botões)
- Seleção de moeda multi-critério (spread, volume, vol, fees, depth, AS)
- Auto-Withdraw (envia lucro para carteira quando reserva ≥ threshold)
- Testnet support, PM2 AFK, heartbeat, dead-man timer

---

## 2. Estado Atual do Código

### Build
- `tsc --noEmit` passa (0 erros)
- `npm run build` gera `dist/`
- Commit mais recente: `53f4f98` (pushed to main)

### Arquivos principais
| Arquivo | Função |
|---|---|
| `src/index.ts` | Bootstrap: compound, reconciler, user stream, MM, Discord, heartbeat |
| `src/config/env.ts` | Configuração (testnet, compound, withdraw, Solana, etc.) |
| `src/modules/trading/market-maker.engine.ts` | MM engine (Avellaneda-Stoikov, vol-targeting, edge gate) |
| `src/modules/trading/compound.service.ts` | Compound com persistência, cap, drawdown, halt, auto-skim |
| `src/modules/trading/auto-withdraw.service.ts` | Withdraw para Solana (transfer) ou Binance (withdraw API) |
| `src/modules/trading/edge-estimator.service.ts` | Normal-Inverse-Gamma sobre PnL em bps. Gate P(μ>0)>0.95 |
| `src/modules/trading/fill-ledger.service.ts` | Persiste fills, calcula PnL round-trip |
| `src/modules/trading/reconciler.service.ts` | Boot: cancela ordens, reconcilia, loga capital |
| `src/modules/trading/binance-user-stream.service.ts` | Captura fills, pairing buy/sell, compound, edge update |
| `src/modules/trading/binance-ws.service.ts` | WebSocket @bookTicker (testnet support) |
| `src/modules/trading/binance.adapter.ts` | REST API (testnet support) |
| `src/modules/trading/exchange-info.service.ts` | Symbol filters (testnet support) |
| `src/modules/discord/bot.ts` | Discord bot (8 comandos + /compound + botões) |
| `ecosystem.config.js` | PM2 config para AFK |

### Módulos pendentes (não implementados)
- CoinSelectorService (seleção de moeda multi-critério)
- MultiPairOrchestrator (distribuição de capital entre pares)
- DEX Micro-Executor (swap real via Jupiter)
- Capital Bootstrap (fase 0→1→2→3)
- Risk Manager IA (drawdown, kill switch, halt)
- Grid multicamadas (MM_GRID_LEVELS não usado)

---

## 3. Lógica do Compound (matemática completa)

### Edge por ciclo
```
edge_liquido = s − 2φ − slippage_estimado
```
Se `edge_liquido ≤ 0` → não operar.

### Taxa de crescimento por ciclo
```
r = f × edge_liquido
```

### Compound exponencial
```
C_n = C_0 × (1 + ρ × r)^n
```
- ρ = reinvestment ratio (0.5)
- n = número de ciclos (round-trips)

### Kelly fracionário (upper bound, não sizing)
```
f* = μ / σ²   (Kelly full)
f_operacional = min(λ × f*, N_vol, N_inventory, N_liquidity)   (λ = 0.25-0.5)
```
Kelly nunca é binding constraint. Sizing real = vol-targeting + cap de risco.

### Volatility targeting
```
f_i = (σ_target / σ_realized_i) × f_base
```
σ_target ≈ 0.25-0.5% equity por ~5 min. EWMA λ=0.94.

### House money (trailing stop no principal)
- Principal P_0 intocável. Só reinveste lucros G.
- Se G consumido → P_0 permanece → ruína impossível.

### Profit stacking (split de lucro)
```
reinvestido = ρ × L_i
reserva = (1 − ρ) × L_i
```
ρ = 0.5 (50% reinvestido, 50% reserva).

### Cap geométrico + drawdown limit
```
f_{i+1} = min(f_i × (1 + ρ × r_i), f_max)   (f_max = 0.15)
D = (C_peak − C_i) / C_peak
if D > 0.15 → HALT
```

### Ruin theory
```
P = exp(−2 · m · B / σ_e²)
```
Se μ ≤ 0 (provável após fees) → ruin é certo.

### Avellaneda-Stoikov (quoting completo)
```
r = s − q · γ · σ² · (T − t)           // reservation price
δ = γ · σ² · (T − t) + (2/γ) · ln(1 + γ/k)  // spread ótimo
δ* = c + 1/k                            // spread ótimo com custo
λ(δ) = A · e^(−kδ)                     // intensidade de fill
```

### Bayesian Edge Estimator (Normal-Inverse-Gamma)
- Modela PnL líquido por round-trip (em bps) como Normal com média e variância desconhecidas.
- Trade só se P(μ > 0 | data) > 0.95.
- Sample sizes: μ=2bps → ~150 round-trips; μ=1bp → ~600; μ=0.5bp → ~2400.

### Auto-Withdraw (profit skimming)
- Quando reserva protegida ≥ WITHDRAW_THRESHOLD → envia lucro para carteira.
- Modos: Solana (transfer via @solana/web3.js) ou Binance (withdraw API).
- Após skim: reserva resetada para 0. Capital de trading continua compounding.

### Diversificação real (correlação)
```
N_eff = N / (1 + (N − 1) × ρ_avg)
```
Com ρ = 0.7 e N = 10 → N_eff ≈ 1.4. Diversificação em crypto é menos eficaz do que √N sugere.

---

## 4. Seleção de Moeda (multi-critério)

Score composto (0-100) com 6 fatores:
- Spread capturável (30%)
- Volume 24h (20%)
- Volatilidade (15%)
- Fees (15%)
- Profundidade do book (10%)
- Adverse selection (10%)

Filtros de exclusão: min notional, spread < 2×fee, volume < $500k, vol > 3×target, correlação > 0.8, blacklist.

Alocação: risk parity (w_i = (1/σ_i) / Σ(1/σ_j)), max 40% por par.

IA (Gemini/Claude) como Opportunity Scanner no slow layer (minutos).

---

## 5. Arquitetura AFK

### Camadas
- **Fast layer (ms):** HMM/GARCH regime detection, vol targeting, Avellaneda-Stoikov quoting, edge gate.
- **Slow layer (minutos):** IA scanner de oportunidades, news reader, compound allocator, rebalanceamento.

### AFK infra
- PM2: auto-restart, max memory 500M, restart delay 5s.
- Heartbeat: log a cada 60s (capital, profit, drawdown, edge).
- Dead-man timer: cancelar tudo se heartbeat morrer.
- Reconciler no boot: cancela ordens abertas, reconcilia saldos, loga capital.
- Idempotent orders (newClientOrderId).
- Diff-depth stream com lastUpdateId resync.
- IP whitelist, trade-only keys, rate limits.

### Hard rules
- Daily loss limit: -10% a -15% de equity → halt até próximo UTC day.
- Per-position stop: 2-3σ.
- Per-pair inventory cap + global flatten a -X% drawdown.
- Consecutive-loss breaker: halt se P(μ>0) < 0.5.

---

## 6. Configuração (.env)

### Essenciais
- `DATABASE_URL`, `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `GEMINI_API_KEY` (ou `ANTHROPIC_API_KEY`)

### Trading (Binance)
- `BINANCE_API_KEY`, `BINANCE_SECRET`, `BINANCE_TESTNET` (true para testnet)
- `MM_SYMBOL` (default BTCUSDT), `MM_MIN_ORDER_USD` (15), `MM_MAX_ORDER_USD` (200)
- `MM_DAILY_STOP_LOSS` (-0.015), `MM_DRIFT_THRESHOLD` (0.002)

### Compound & Auto-Withdraw
- `MM_CAPITAL_BASE` (100), `MM_REINVESTMENT_RATIO` (0.5), `MM_DRAWDOWN_LIMIT` (0.15)
- `WITHDRAW_THRESHOLD` (0.5), `WITHDRAW_DESTINATION`, `WITHDRAW_ASSET` (USDT)

### Solana DEX
- `SOLANA_RPC_URL`, `SOLANA_PRIVATE_KEY`, `DEX_AUTO_BUY_ENABLED`, `DEX_MIN_AI_SCORE` (90)

---

## 7. Comandos Discord

| Comando | Descrição |
|---|---|
| `/analyze <address>` | Auditoria de segurança + IA |
| `/ask <query>` | Consulta semântica RAG |
| `/track <address> <entry_price>` | Rastrear posição com trailing stop |
| `/swap <mint> [amount_sol]` | Simular swap via Jupiter |
| `/radar` | Estatísticas do radar |
| `/market` | Macro (Fear & Greed, BTC, ETH) |
| `/mm [status\|start\|stop]` | Controlar market maker |
| `/gains` | Posições ativas e PnL |
| `/compound` | Capital, profit, drawdown, edge, shouldTrade |

---

## 8. IA Configurável

O motor de IA é **configurável** — não está preso a um provider:
- **Google Gemini** (padrão): due diligence, embeddings, regime analysis
- **Claude (Anthropic)**: alternativa para due diligence e análise
- **Heurístico**: fallback quantitativo quando IA offline

A IA **não trade diretamente** — ela gerencia: regime detection, edge estimation, opportunity scanning, risk management.

---

## 9. Veredito: funciona "de maneira perfeita"?

**Não. E essa é a resposta honesta.**

- Com $1: expected outcome é **perda**, não doubling. Min notional $5 na Binance.
- Edge real de retail é zero a negativo após fees (20 bps round-trip spot).
- Doubling em um dia é improvável. 100 round-trips → 70bps edge necessário.

**O que o plano FAZ bem:** Serve como **framework de descoberta de edge**. Se rodar em testnet e medir μ com credible intervals, vai dizer honestamente se você tem edge ou não. Se não tiver, o framework impede que você perca dinheiro real.

> **O framework é mais valioso do que uma promessa de doubling.**

---

## 10. Próximos Passos

1. **Testar em testnet** (1-3 dias) — coletar dados, verificar edge
2. **Se edge positivo** → live com $25-$50
3. **Implementar pendentes:** CoinSelector, MultiPairOrchestrator, DEX sniper, grid, AFK infra, testes
4. **Nunca ir live** até P(μ>0) > 0.95 em testnet com ≥300 round-trips

---

## 11. Documentação

| Arquivo | Conteúdo |
|---|---|
| `docs/status.md` | Checklist de milestones e pendências |
| `docs/auto-farm-afk.md` | Lógica, fórmulas, arquitetura, IA, insights |
| `docs/coin-selection.md` | Estratégia de seleção de moeda/pares |
| `docs/action-plan.md` | Resumo de ação, config, comandos |
| `binance-automation/CONTEXT.md` | Este arquivo (contexto completo) |

---

## 12. Commits Recentes

| Commit | Descrição |
|---|---|
| `53f4f98` | docs: update action plan with auto-withdraw, PM2, heartbeat |
| `3e6798f` | feat: add auto-withdraw (profit skimming), PM2 config, heartbeat |
| `47e5d3b` | docs: add action plan summary for auto-farm AFK |
| `366a075` | feat: implement testnet support, Avellaneda-Stoikov, edge estimator, etc. |
| `2d9c5a5` | docs: simplify and update README |
| `8f2b549` | docs: add coin/pair selection strategy |
| `7fbc551` | docs: integrate external AI insights |

---

*Gerado em: Nov 2026. Projeto: Cortex Crypto Sentinel. Repo: https://github.com/Andr3wGustavo/crypto-tools*
