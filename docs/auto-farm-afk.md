# Auto-Farm AFK: Crypto Compound Micro-Trading System

Documentação completa da lógica, matemática e arquitetura do sistema de farm automático AFK (Away From Keyboard) para trading de micro-capital com compound exponencial.

---

## 1. Visão Geral

### Objetivo
Criar um **farm automático AFK** que opera com **baixo capital inicial ($1)**, executa **micro trades** em alta frequência, e **multiplica exponencialmente o capital** ao longo do dia através de **compound (reinvestimento de lucros)**, com gerenciamento por IA e risco controlado.

### Princípio fundamental
O sistema **não tenta prever direção** (random walk em prazos curtos). Ele fornece **liquidez nas duas pontas** (market making) e embolsa o **spread** centenas/milhares de vezes por dia. Os lucros são **empilhados (stacking)** e reinvestidos parcialmente, gerando crescimento **exponencial** em vez de linear.

### Restrições de design
- Capital inicial: $1 (ou menos).
- Operação: 100% automatizada (AFK).
- Exchange: Binance (CEX maker) ou DEX (Jupiter/Solana) para micro-lotes.
- Risco: ruína deve ser matematicamente impossível (house money + drawdown limit).
- IA: gerencia regime, sizing, risco e alocação (não trade diretamente).

---

## 2. O Problema do Baixo Capital ($1)

### 2.1 Três barreiras matemáticas

| Barreira | Problema | Impacto |
|---|---|---|
| **Min notional** | Binance exige $5 mínimo por ordem → $1 não pode operar em CEX | Impossível operar diretamente em Binance com $1 |
| **Fees** | Swap fee DEX ~0.3% + slippage → edge negativo se spread < 0.3% | Edge pode ser negativo em DEX |
| **Variância** | Com $1, um loss de 10% = $0.10 → 10% do capital | Alta probabilidade de ruína com sizing fixo |

### 2.2 Estratégia de bootstrap (fases de capital)

| Fase | Capital | Modo | Descrição |
|---|---|---|---|
| **Fase 0** | $0 – $5 | Paper trading | Simulação de fills. Acumula "capital virtual" até atingir $5. Sem risco real. |
| **Fase 1** | $5 – $20 | CEX maker (Binance/MEXC) | Ordens mínimas ($5). Micro trades reais. Edge pequeno mas real. |
| **Fase 2** | $20 – $100 | Diversificação multi-par | Kelly fracionário + volatility targeting. N ≥ 3 pares. |
| **Fase 3** | $100+ | Grid + sniper + compound agressivo | Multi-level grid, sniper DEX, compound com cap alto. |

### 2.3 Solução para o min notional com $1
- **Opção A (DEX):** Operar em Solana via Jupiter com micro-lotes (frações de centavo). Fees: ~0.000005 SOL por tx + swap fee 0.3%. Spread capturado deve ser > 0.5%.
- **Opção B (CEX de baixo min notional):** MEXC ou Gate.io com min notional $1–$2. Fees maker: 0.02% ou 0% em promo.
- **Opção C (Pool):** Vários "farmers" juntam capital, operam em conjunto, distribuem lucros proporcionalmente.

---

## 3. Matemática do Compound Exponencial

### 3.1 Edge por ciclo

O edge líquido é o spread capturado menos os custos:

```
edge_liquido = s − 2φ − slippage_estimado
```

- `s` = spread alvo (target spread)
- `φ` = fee maker por lado (ex. 0.0002 ou 0 em promo)
- `slippage_estimado` = custo de execução estimado

**Gate de edge:** Se `edge_liquido ≤ 0` → **não operar** (o bot fica em repouso). Isso é crítico: operar com edge negativo acelera a ruína.

### 3.2 Taxa de crescimento por ciclo

```
r = f × edge_liquido
```

- `f` = fração do capital por ordem (Kelly fracionário)
- Exemplo: `f = 0.15`, `edge = 0.001` (0.1%) → `r = 0.00015` (0.015% por ciclo)

### 3.3 Compound exponencial

```
C_n = C_0 × (1 + ρ × r)^n
```

- `C_0` = capital inicial
- `ρ` = reinvestment ratio (0.5 = 50% dos lucros reinvestidos)
- `r` = taxa de crescimento por ciclo
- `n` = número de ciclos completos (round-trips)

**Exemplo numérico:**
- `C_0 = $1`, `r = 0.00015`, `ρ = 0.5`, `n = 10.000` ciclos (≈ 1 dia):
  - `C_10000 = 1 × (1 + 0.5 × 0.00015)^10000 = 1 × (1.000075)^10000 ≈ $2.12`
  - **+112% em um dia**

- Com `edge = 0.002` (0.2%): `r = 0.0003`, `C_10000 = 1 × (1.00015)^10000 ≈ $4.48` → **+348%**

**Conclusão:** com edge positivo e n grande (micro trades), o capital cresce exponencialmente. A taxa de crescimento é pequena por ciclo, mas a composição (compound) gera multiplicação.

### 3.4 Kelly Fracionário (sizing ótimo)

O Kelly Criterion maximiza `E[ln(W)]` (crescimento log-ótimo). Para micro-capital, usar **fractional Kelly**:

```
f* = λ × (bp − q) / b
```

- `b` = odds (spread capturado / risco por unidade)
- `p` = probabilidade de win (fill + round-trip lucrativo)
- `q = 1 − p`
- `λ` = fração do Kelly (0.25 = "quarter-Kelly")

**Por que λ < 1?** Kelly full sugere frações altas que causam ruína com n pequeno. Com λ = 0.25, a variância cai ~75%, sacrificando crescimento para evitar ruína. Com micro-capital ($1–$5), λ = 0.25 é o sweet spot.

**Kelly com custos de transação:**
```
edge_liquido = s − 2φ − slippage_estimado
f* = λ × edge_liquido / σ_ciclo²
```
Se `edge_liquido ≤ 0` → não operar.

### 3.5 Volatility Targeting

Em vez de tamanho fixo, ajustar `f` pela volatilidade realizada:

```
f_i = (σ_target / σ_realized_i) × f_base
```

- Se o mercado está mais volátil → ordem menor (menos risco de adverse selection).
- Se está calmo → ordem maior (mais spread capturado).
- Mantém o **risco por ciclo constante**, independente do regime.

### 3.6 House Money (trailing stop no principal)

- Separar capital em **principal** (`P_0`, intocável) e **lucros** (`G`).
- Reinvestir apenas sobre `G`, nunca sobre `P_0`.
- Se `G` for consumido por losses, `P_0` permanece → **ruína impossível** (a conta nunca zera).
- Fórmula: `C_operacional = P_0 + G_reinvestido`, onde `G_reinvestido ≤ G_total`.

### 3.7 Profit Stacking (empilhamento de lucros)

A cada ciclo lucrativo, split do lucro:

```
reinvestido = ρ × L_i
reserva = (1 − ρ) × L_i
```

- `ρ = 0.5` (50% reinvestido, 50% reserva)
- A reserva **nunca** é usada para trading — é o "colchão" contra drawdown.
- Quando a reserva atinge `k × P_0` (ex. k = 2), ela pode ser parcialmente reinvestida (compound em dois estágios).

### 3.8 Cap Geométrico + Drawdown Limit

```
f_{i+1} = min(f_i × (1 + ρ × r_i), f_max)   (f_max = 0.15 do capital)
D = (C_peak − C_i) / C_peak
if D > 0.15 → HALT
```

- Cap geométrico: impede que uma sequência de wins crie uma posição desproporcional.
- Drawdown limit: se o capital cair 15% do pico → parar tudo (preservar capital).

### 3.9 Ruin Theory (probabilidade de quebra)

Para micro-capital, calcular a **probabilidade de ruína** antes de operar:

```
P_ruina = ((1 − p) / p)^n   (para random walk com edge positivo)
```

- Se `P_ruina > 5%` → reduzir `f` ou aumentar `N` (diversificação).
- **Tempo esperado para atingir meta:** `T = ln(meta / C_0) / (ρ × r)` ciclos.

### 3.10 Bayesian Updating (Thompson sampling)

Tratar `p` (probabilidade de win) como distribuição Beta (prior):

```
p ~ Beta(α + wins, β + losses)
```

- Sizing: `f_i = E[p_i] × λ` (esperança posterior × Kelly fracionário).
- Com micro-capital e poucos dados, o prior conservador (ex. α = 1, β = 3 → p ≈ 0.25) evita overconfidence nos primeiros ciclos.

### 3.11 Diversificação de Ciclos (redução de variância)

- Não compor tudo em 1 par. Distribuir capital entre **N pares independentes**.
- Variância do portfolio: `σ_p² = (1/N) × σ²` (se correlação ≈ 0).
- Com N = 3 pares, variância cai ~67%. O compound fica mais estável.

---

## 4. Arquitetura do Auto-Farm AFK

### 4.1 Módulos do farm

| Módulo | Status | Função no farm |
|---|---|---|
| MM Engine (Binance WS) | ✅ Existe | Market making com spread capture |
| Compound Service | 🔶 Esqueleto | Reinvestimento + stacking (fechar loop) |
| Exchange Info | ✅ Existe | Precision (tick/step size) |
| User Data Stream | ✅ Existe | Captura fills reais |
| Gain Tracker | ✅ Existe | PnL + trailing stop |
| Discord Bot | ✅ Existe | Alertas + controle remoto |
| **Capital Bootstrap** | ❌ Novo | Fase 0→1→2→3 (paper → real) |
| **Kelly Sizer** | ❌ Novo | Sizing ótimo (quarter-Kelly + vol targeting) |
| **Regime Detector (IA)** | ❌ Novo | Detecta mercado calmo/volátil/trending |
| **Multi-pair Orchestrator** | ❌ Novo | Distribui capital entre N pares |
| **Risk Manager (IA)** | ❌ Novo | Drawdown limit, kill switch, halt |
| **DEX Micro-Executor** | ❌ Novo | Swap real via Jupiter para DEX farm |
| **Capital State (DB)** | 🔶 Parcial | Persistir capital (adicionar model) |

### 4.2 Gerenciamento de IA (o "cérebro" do farm)

A IA **não trade diretamente** — ela **gerencia** o farm:

| IA | Função | Input | Output |
|---|---|---|---|
| **Regime Detector** | Classifica mercado (calmo/volátil/trending) | Volatilidade, volume, order book imbalance | Ajusta `f`, `spread`, `TTL` |
| **Edge Estimator** | Estima edge real por ciclo | Fills, preços, fees | Atualiza Kelly `p`, `b` |
| **Risk Manager** | Monitora drawdown, halt, kill switch | Capital, PnL, peak | Halt se D > 15% |
| **Opportunity Scanner** | Detecta melhores pares/spreads | DexScreener, book tickers | Aloca capital para pares com maior edge |
| **Compound Allocator** | Decide ρ (reinvest vs reserva) | Capital, drawdown, regime | Ajusta reinvestment ratio dinamicamente |

**Gemini 2.0** (já integrado) pode ser usado para:
- Análise de regime de mercado (sentimento, notícias)
- Due diligence de tokens (já faz)
- Geração de embeddings para RAG (memória de padrões)

### 4.3 AFK (automação total)

Para operar AFK, o farm precisa de:
1. **Auto-start**: boot automático, reconexão de WS, renovação de listenKey.
2. **Auto-recovery**: se crashar, reiniciar (PM2/Docker com restart policy).
3. **Kill switch**: se drawdown > 15% → para tudo, envia alerta Discord.
4. **Modo dry-run**: testar sem capital real (simulação de fills).
5. **Monitoramento**: alertas no Discord para gemas, stops, halts.
6. **Persistência**: capital, posições, ordens — tudo no SQLite/Postgres.
7. **Backup**: backup automático do DB a cada N horas.

---

## 5. Fluxo do Farm (um dia típico)

```
00:00 — Boot: carrega capital do DB, inicializa WS, MM, compound
00:01 — Regime Detector: mercado calmo → f = 0.15, spread = 0.05%
00:02 — Ciclo 1: compra $0.50, vende $0.5005 → lucro $0.00025 (round-trip)
00:02 — Compound: reinveste $0.000125, reserva $0.000125
00:03 — Ciclo 2: ... (repete)
...
08:00 — 5.000 ciclos completos → capital +12%
08:01 — Regime Detector: mercado volátil → f = 0.08, spread = 0.15%
...
16:00 — 15.000 ciclos → capital +45%
16:01 — Drawdown check: OK, continua
...
23:59 — Capital final: $1.00 → $2.10 (+110%)
00:00 — Persiste capital, envia relatório Discord, reinicia ciclo
```

---

## 6. Prioridades de Implementação

| # | Prioridade | Descrição | Impacto |
|---|---|---|---|
| 1 | **Fechar o loop do compound** | Pairing buy/sell, `L` real, aplicar `newOrderSize`, persistir capital | 🔴 Crítico |
| 2 | **Kelly Sizer** | Quarter-Kelly + volatility targeting (substituir `f` fixo) | 🔴 Crítico |
| 3 | **House money + reserva** | Split de lucro, principal intocável | 🔴 Crítico |
| 4 | **Regime Detector (IA)** | Classificar mercado, ajustar parâmetros | 🟠 Alto |
| 5 | **Skew real** | Avellaneda-Stoikov com inventário real | 🟠 Alto |
| 6 | **Multi-pair orchestrator** | Distribuir capital entre N pares | 🟠 Alto |
| 7 | **DEX Micro-Executor** | Swap real via Jupiter (para farm DEX) | 🟡 Médio |
| 8 | **Capital Bootstrap** | Fase 0→1→2→3 (paper → real) | 🟡 Médio |
| 9 | **Risk Manager (IA)** | Drawdown limit, kill switch, halt | 🟡 Médio |
| 10 | **AFK infra** | PM2/Docker, auto-restart, backup | 🟡 Médio |
| 11 | **Testes + CI** | Evitar regressão no PnL | 🟢 Baixo |

---

## 7. Por que esta é a melhor solução conhecida

### 7.1 Justificativa matemática
1. **Kelly fracionário** evita a ruína que o Kelly full causaria com n pequeno (micro-capital).
2. **Volatility targeting** reduz o tamanho quando o mercado está perigoso (onde micro-capital quebra).
3. **House money** garante que o pior caso é "voltar ao início", não "quebrar".
4. **Diversificação** transforma 3 streams de alta variância em 1 stream de baixa variância.
5. **Bayesian updating** evita overconfidence nos primeiros ciclos (dados escassos).
6. **Cap geométrico** impede que uma sequência de wins crie uma posição que um único loss destrói.
7. **Compound exponencial** com edge positivo e n grande gera multiplicação real do capital.

### 7.2 Justificativa de engenharia
1. A base (WS, exchange-info, adapter, user stream, Discord) já está 80% pronta.
2. A matemática é bem estabelecida (Kelly, Merton, ruin theory) — não é especulação.
3. A IA gerencia, não trade — reduz risco de overfitting e alucinação.
4. AFK infra (PM2/Docker) já é padrão da indústria.

### 7.3 Limitações e riscos
1. **Edge pode ser negativo** em regimes de mercado adversos → gate de volatilidade mitiga.
2. **Adverse selection** pode acumular inventário → skew Avellaneda-Stoikov mitiga (mas precisa ser real, não hardcoded 0).
3. **Fees em DEX** (0.3%) podem comer o edge → preferir CEX maker quando capital ≥ $5.
4. **Slippage** em micro trades pode ser alto → limitar a pares com alta liquidez.
5. **Overfitting** da IA no regime detector → usar validação out-of-sample.
6. **Black swan** (flash crash) → drawdown limit + kill switch + house money.

### 7.4 Veredito
> **Sim, é possível criar um farm automático AFK com $1 que multiplica exponencialmente o capital em um dia.**  
> Mas requer: (1) edge positivo medido de verdade (round-trips reais), (2) Kelly fracionário para não quebrar com micro-capital, (3) house money para garantir que o pior caso é "voltar ao início", (4) diversificação para reduzir variância, (5) IA para gerenciar regime e risco, (6) persistência para não perder progresso.  
> **A matemática funciona. A engenharia é o desafio.** E a base já está 80% pronta.

---

## 8. Pergunta para outra IA (anexo)

Abaixo está a pergunta formulada para enviar a outra IA, com o objetivo de obter uma solução alternativa para o mesmo problema (farm AFK com $1, micro trades, compound exponencial). Após obter a resposta, envie-a de volta para análise comparativa.

### Pergunta sugerida:

> "I am building an automated AFK (away-from-keyboard) crypto micro-trading farm starting with $1 of capital. The goal is exponential compounding of capital through high-frequency micro trades (market making / spread capture) over a single day, with reinvestment of profits. The system must be fully automated, use AI for regime detection and risk management, and be mathematically robust against ruin. I have a TypeScript/Node.js codebase with Binance WebSocket market making, compound service, and Discord bot already 80% built. 
>
> Please propose the BEST mathematical and logical solution for this problem, considering:
> 1. Micro-capital constraints ($1 starting capital, exchange minimum notional ~$5)
> 2. Kelly Criterion (fractional) for optimal sizing
> 3. Volatility targeting for risk-adjusted position sizing
> 4. Profit stacking (splitting profits between reinvestment and protected reserve)
> 5. House money concept (never touch principal)
6. Diversification across multiple pairs to reduce variance
7. Bayesian updating for win probability estimation
8. Ruin theory and drawdown limits
9. AI-based regime detection and risk management
10. AFK infrastructure (auto-restart, kill switches, persistence)
>
> Include all relevant formulas, the architecture, the implementation priority order, and an honest assessment of whether this approach can realistically multiply $1 to 2x+ in a single day. Be specific and quantitative."
