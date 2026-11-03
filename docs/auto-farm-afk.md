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

### 3.1.1 Avellaneda-Stoikov (modelo completo de quoting)

**Insight da análise externa:** O modelo completo de Avellaneda-Stoikov fornece a fórmula exata do spread ótimo e da intensidade de fill.

**Variáveis:**
- `q` = inventário (posição atual)
- `γ` = aversão ao risco
- `σ` = volatilidade
- `T − t` = tempo restante até o fim do horizonte
- `k` = decaimento da profundidade do book (order-book depth decay)
- `s` = preço mid atual

**Preço de reserva:**
```
r = s − q · γ · σ² · (T − t)
```

**Spread ótimo:**
```
δ = γ · σ² · (T − t) + (2/γ) · ln(1 + γ/k)
```

**Intensidade de fill:**
```
λ(δ) = A · e^(−kδ)
```

**Spread ótimo com custo:**
```
δ* = c + 1/k
```
onde `c` = custo total por fill (fee + adverse selection estimado).

**Regra de negócio:** Se não consegue cotar em `δ*` e ser competitivo na fila (queue position), não tem negócio naquele par. O `δ*` é o mínimo viável.

**Net por fill:**
```
net_fill = δ − fee − AS
```
onde `AS` = adverse selection (o termo que mata a maioria dos market makers retail).

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

### 3.4 Kelly Fracionário (upper bound, não sizing)

O Kelly Criterion maximiza `E[ln(W)]` (crescimento log-ótimo). Para retornos contínuos:

```
f* = μ / σ²
```

**Insight da análise externa:** Kelly nunca é o binding constraint. Com μ = 2 bps e σ = 15 bps, f* ≈ 89x (absurdo). O sizing real é limitado por **tail risk, inventário e min notional**, não por Kelly.

**Kelly serve como upper bound teórico, não como sizing operacional:**

```
N = min(f_kelly × E, N_vol, N_inventory, N_liquidity)
```

- `f_kelly` = Kelly fracionário (λ = 0.25–0.5 do Kelly full)
- `N_vol` = vol-targeted size
- `N_inventory` = cap de inventário
- `N_liquidity` = cap de liquidez

**Half-Kelly:** dá ~75% do crescimento máximo com ~25% da variância. Fator de crescimento: `c(2 − c)` com c = 0.5 → 0.75.

**Se μ ≤ 0 → Kelly diz size = 0.** Até o posterior mostrar edge, não operar.

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

- σ_realizado: EWMA `σ̂² = λσ̂²_{t−1} + (1−λ)r_t²` (λ ≈ 0.94) ou Parkinson/Garman-Klass em barras de 1 min.
- σ_target ≈ 0.25–0.5% de equity por ~5 min.
- Hard leverage cap: 1x spot.
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

**Insight da análise externa:** Para log-equity com drift `m` e variância `σ_e²` por step:

```
P = exp(−2 · m · B / σ_e²)
```

Mesma forma para `P(max drawdown ≥ D)`.

**Exemplo ilustrativo:** μ = 0.5 bps net, σ = 15 bps, L = 5 → m ≈ 2.2e-4, σ_e² ≈ 5.6e-5 por trade → P(50% drawdown) ≈ 0.5%.

**Caveats críticos:**
- Assume edge conhecido e Gaussiano — **nenhum dos dois vale na prática**.
- Fat tails e μ errado dominam.
- **Se μ ≤ 0 (caso provável após fees), ruin é certo** dado trades suficientes.

**Hard rules:**
- Daily loss limit: −10% a −15% de equity (halt até próximo UTC day).
- Per-position stop: 2–3σ.
- Per-pair inventory cap + global flatten a −X% drawdown do high-water mark.
- Consecutive-loss breaker: halt se P(μ>0) < 0.5.

- Se `P_ruina > 5%` → reduzir `f` ou aumentar `N` (diversificação).
- **Tempo esperado para atingir meta:** `T = ln(meta / C_0) / (ρ × r)` ciclos.

### 3.10 Bayesian Edge Estimation (Normal-Inverse-Gamma)

**Insight da análise externa:** Não usar Beta-Binomial sobre win rate (ignora tamanho do payoff). Modelar o PnL líquido por round-trip (em bps) como Normal com média e variância desconhecidas (Normal-Inverse-Gamma conjugate prior, atualizado a cada fill).

```
μ ~ NIG(μ_0, κ_0, α_0, β_0)   // prior conjugado
// após n fills: posterior atualizado
// Trade só se P(μ > 0 | data) > 0.95
```

- Win rate sozinho é enganoso: 90% de win rate com losses 10x maiores = edge negativo.
- PnL em bps captura tamanho do payoff, não só frequência.
- Beta(α, β) ainda é útil para **probabilidade de fill** por quote (separado do edge).

**Sample sizes necessários** (σ ≈ 15 bps por trade, one-sided 95%): `n ≈ (1.645 × σ / μ)²`

| Edge real (μ) | Round-trips necessários |
|---|---|
| 2 bps | ~150 |
| 1 bp | ~600 |
| 0.5 bp | ~2.400 |

Corrigir para selection bias se escolher o melhor de vários pares. Usar Thompson sampling para alocar capacidade de quoting entre pares.

### 3.11 Diversificação de Ciclos (redução de variância real)

**Insight da análise externa:** Crypto intraday tem correlação alta (ρ ≈ 0.6–0.8). A diversificação ajuda muito menos do que o √N sugere.

```
N_eff = N / (1 + (N − 1) × ρ)
```

- Com ρ = 0.7 e N = 10 pares: `N_eff = 10 / (1 + 9 × 0.7) = 10 / 7.3 ≈ 1.4` independentes.
- Na prática, 10 pares de crypto intraday se comportam como ~1.4 pares independentes.
- **Diversificação em crypto é menos eficaz do que o modelo √N sugere.**
- Para vol-targeting multi-par: `w'Σw ≤ σ_target²` (covariância real, não independência assumida).

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

### 4.2 Gerenciamento de IA (dois layers: fast + slow)

**Insight da análise externa:** O hot path deve ser **determinístico** (ms). LLM é muito lento e inconsistente para market making. LLM só como **supervisor lento** (minutos).

**Fast layer (determinístico, ms — hot path):**

| Componente | Função | Input | Output |
|---|---|---|---|
| **Regime Detector** | Classifica mercado (calmo/volátil/tóxico) | Vol ratio, order book imbalance, VPIN, spread shocks | Ajusta `δ`, `f`, `TTL` ou puxa quotes |
| **Edge Estimator** | Estima edge real por ciclo | Fills, preços, fees | Normal-Inverse-Gamma posterior → gate P(μ>0) |
| **Risk Manager** | Monitora drawdown, halt, kill switch | Capital, PnL, peak, inventário | Halt se D > 15%, stop per-position 2–3σ |
| **Vol Targeter** | Ajusta sizing por volatilidade | σ_realizado, σ_target | `f_i = (σ_target/σ_i) × f_base` |

Modelo: 3-state HMM ou GARCH-regime (quiet / trending / toxic). Walk-forward validation (não in-sample).

**Slow layer (LLM supervisor, minutos — não no hot path):**

| Componente | Função | Input | Output |
|---|---|---|---|
| **News/Status Reader** | Lê notícias e status da exchange | News feeds, exchange status | Flip flag "halt/reduce" (nunca coloca ordens) |
| **Opportunity Scanner** | Detecta melhores pares/spreads | DexScreener, book tickers | Aloca capital para pares com maior edge |
| **Compound Allocator** | Decide ρ (reinvest vs reserva) | Capital, drawdown, regime | Ajusta reinvestment ratio dinamicamente |

**Gemini 2.0** (já integrado) é usado no slow layer:
- Análise de regime de mercado (sentimento, notícias)
- Due diligence de tokens (já faz)
- Geração de embeddings para RAG (memória de padrões)

### 4.3 AFK (automação total)

**Insight da análise externa:** Reconciliação de estado após crash é crítica. Sem idempotência, ordens duplicadas.

Para operar AFK, o farm precisa de:
1. **Auto-start**: boot automático, reconexão de WS, renovação de listenKey.
2. **Auto-recovery**: se crashar, reiniciar (PM2/Docker com restart policy).
3. **Kill switch**: se drawdown > 15% → para tudo, envia alerta Discord.
4. **Modo dry-run**: testar sem capital real (simulação de fills).
5. **Monitoramento**: alertas no Discord para gemas, stops, halts.
6. **Persistência**: capital, posições, ordens — tudo no SQLite/Postgres.
7. **Backup**: backup automático do DB a cada N horas.
8. **Reconciliação no boot**: cancelar todas as ordens abertas, reconciliar saldos e fills com a exchange, reconstruir estado, só então cotar.
9. **Idempotent orders**: usar `newClientOrderId` único por ordem (evita duplicatas em retry).
10. **Diff-depth stream**: usar stream de diff-depth com `lastUpdateId` resync (reconexão com backoff).
11. **Dead-man timer**: cancelar tudo se heartbeat próprio morrer (spot não tem cancel-on-disconnect).
12. **Segurança de chaves**: trade-only permission, withdrawals desabilitadas, IP whitelist, rate limits.

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

## 9. Insights da análise externa (segunda IA) — o que mudou

### 9.1 Resumo do que a outra IA disse
A segunda IA (mais rigorosa e pessimista) deu um **veredicto honesto**: com $1, o resultado esperado é **perda do $1**, não doubling. O $1 é pequeno demais para a estratégia rodar (min notional $5 na Binance). Compound não cria edge — amplifica um edge que provavelmente não existe para retail.

### 9.2 Novos insights (além do que já tínhamos)

1. **Normal-Inverse-Gamma em vez de Beta-Binomial** — modelar PnL em bps, não win rate. Trade só se P(μ>0) > 0.95.
2. **Avellaneda-Stoikov completo** — δ* = c + 1/k, fill intensity λ(δ) = A·e^(−kδ). Se não consegue cotar em δ*, sem negócio.
3. **Kelly nunca é binding constraint** — com μ=2bps, σ=15bps, f*≈89x. Sizing real = vol-targeting + cap de risco.
4. **Diversificação real com correlação** — com ρ=0.7, 10 pares ≈ 1.4 independentes (não √N).
5. **LLM não no hot path** — hot path determinístico (HMM/GARCH, ms); LLM só supervisor lento (minutos).
6. **AFK infra rigorosa** — idempotent newClientOrderId, diff-depth resync, dead-man timer, IP whitelist.
7. **Honest assessment** — tabela de edge necessário por n round-trips. 100 round-trips → 70bps edge. Realista: zero a negativo.

### 9.3 O que mudou na prática

| Antes | Depois (com insights da segunda IA) |
|---|---|
| Beta-Binomial (win rate) | Normal-Inverse-Gamma (PnL em bps) |
| Kelly fracionário como sizing | Kelly como upper bound; sizing = vol-targeting + cap |
| Spread heurístico (Respiro) | Avellaneda-Stoikov completo (δ*, fill intensity) |
| Diversificação √N | Correlação real (N_eff muito menor) |
| IA no hot path | Fast layer (determinístico) + slow layer (LLM) |
| PM2/Docker básico | + idempotent orders, diff-depth, dead-man, IP whitelist |
| "Possível com ressalvas" | "Expected loss, not doubling" — mais honesto |
| Prioridade 1: fechar loop | Prioridade 1: Fill/PnL ledger + reconciliação + testnet |

### 9.4 O plano da farm AFK vai funcionar "de maneira perfeita"?

**Não.** E essa é a resposta honesta.

- **Com $1:** O expected outcome é **perda**, não doubling. O $1 é pequeno demais (min notional $5). Precisa de $25–$50 para validar.
- **O edge real de retail é zero a negativo** após fees (20 bps round-trip spot). Compound não cria edge — amplifica.
- **Doubling em um dia é improvável.** A tabela da segunda IA mostra: 100 round-trips → 70bps edge necessário. Realista: zero.
- **O que o plano FAZ bem:** Serve como **framework de descoberta de edge**. Se rodar em testnet e medir μ com credible intervals, vai dizer honestamente se você tem edge ou não. Se não tiver, o framework impede que você perca dinheiro real.

> **Veredito final:** O plano não é uma "máquina de doubling". É um **sistema de medição e otimização de edge** que, se o edge existir, vai compor exponencialmente. Se não existir, vai te dizer a verdade antes de você perder dinheiro. **Isso é mais valioso do que uma promessa de doubling.**

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
