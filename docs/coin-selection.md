# Seleção de Moeda/Pa para o Auto-Farm AFK

## 1. Visão Geral

O bot não opera em uma única moeda fixa. Ele **avalia continuamente** todos os pares disponíveis e seleciona os melhores com base em critérios quantitativos e de IA. A seleção é dinâmica: pares são adicionados/removidos conforme o regime de mercado muda.

---

## 2. Critérios Quantitativos (scoring multi-critério)

Cada par recebe um **score composto** (0-100) baseado em 6 fatores:

### 2.1 Spread capturável (peso: 30%)
```
spread_score = min(spread_bps / target_spread_bps, 1.0) × 100
```
- `spread_bps` = spread atual do par em basis points
- `target_spread_bps` = spread mínimo desejado (ex. 5 bps)
- Se o spread for menor que o target, o par não tem edge suficiente.

### 2.2 Volume 24h (peso: 20%)
```
volume_score = min(volume_24h / min_volume, 1.0) × 100
```
- `min_volume` = volume mínimo aceitável (ex. $1M/dia)
- Volume alto = mais fills, menos slippage.

### 2.3 Volatilidade realizada (peso: 15%)
```
vol_score = 100 - |σ_realized - σ_target| / σ_target × 100
```
- Volatilidade muito alta = adverse selection alto.
- Volatilidade muito baixa = spread muito pequeno (edge negativo).
- Ideal: volatilidade próxima do target (ex. 0.3-0.5% por ciclo).

### 2.4 Fees (peso: 15%)
```
fee_score = (1 - fee_maker / max_fee) × 100
```
- Pares com fee maker 0% (promo) recebem score máximo.
- Pares com fee > 0.05% recebem score baixo.

### 2.5 Liquidez do book (peso: 10%)
```
depth_score = min(depth_usd / min_depth, 1.0) × 100
```
- `depth_usd` = soma de bid+ask nos primeiros N níveis
- `min_depth` = profundidade mínima (ex. $10k)
- Book profundo = menos slippage, mais fills.

### 2.6 Adverse selection (peso: 10%)
```
as_score = (1 - AS_estimated / max_AS) × 100
```
- `AS_estimated` = estimativa de adverse selection (baseada em VPIN, trade flow toxicity)
- AS alto = fills acontecem quando preço vai contra você → edge negativo.

### 2.7 Score composto
```
total_score = 0.30 × spread_score
            + 0.20 × volume_score
            + 0.15 × vol_score
            + 0.15 × fee_score
            + 0.10 × depth_score
            + 0.10 × as_score
```

**Threshold:** Só opera em pares com `total_score ≥ 60`.

---

## 3. Filtros de exclusão (hard filters)

Antes do scoring, pares são excluídos se:

| Filtro | Condição de exclusão |
|---|---|
| Min notional | `min_notional > capital_disponível / 5` |
| Spread mínimo | `spread_bps < 2 × fee_bps` (edge negativo garantido) |
| Volume mínimo | `volume_24h < $500k` |
| Volatilidade extrema | `σ_realized > 3 × σ_target` (adverse selection alto) |
| Correlação | Se já opera em par correlacionado (>0.8), excluir (diversificação real) |
| Blacklist | Pares com histórico de manipulação/flash crash |

---

## 4. Seleção multi-pair (diversificação)

### 4.1 Número de pares
- **Mínimo:** 1 par (capital < $20)
- **Ideal:** 3-5 pares (capital $20-$100)
- **Máximo:** 8-10 pares (capital > $100)

### 4.2 Alocação de capital
Distribuir capital entre pares selecionados usando **risk parity**:

```
w_i = (1/σ_i) / Σ(1/σ_j)   para todos os pares j selecionados
```

- Pares com menor volatilidade recebem mais capital.
- Limitar: `w_i ≤ 0.4` (nenhum par recebe mais de 40% do capital).

### 4.3 Correlação real (N_eff)
```
N_eff = N / (1 + (N-1) × ρ_avg)
```
- `ρ_avg` = correlação média entre os pares selecionados
- Se `N_eff < 2`, a diversificação é ilusória → reduzir N ou escolher pares menos correlacionados.

### 4.4 Rebalanceamento
- Reavaliar pares a cada **1 hora** (ou quando regime muda).
- Se um par cai abaixo do threshold de score → remover e substituir pelo próximo melhor.
- Se um par tem drawdown > 10% → remover imediatamente.

---

## 5. IA: Opportunity Scanner (slow layer)

A IA (Gemini 2.0) atua como **scanner de oportunidades** no slow layer (minutos):

### 5.1 Input
- Lista de todos os pares disponíveis na exchange
- Dados de mercado: spread, volume, volatilidade, book depth, fees
- Notícias e eventos (via Gemini)
- Histórico de performance de cada par (RAG memory)

### 5.2 Processamento
1. Filtrar pares por hard filters (seção 3).
2. Calcular score composto (seção 2).
3. Consultar RAG memory: "este par teve edge positivo no passado?"
4. Consultar Gemini: "há eventos que podem afetar este par?"
5. Rankear pares por score composto + RAG + IA.

### 5.3 Output
- Lista ranqueada de pares com score, motivo e alocação sugerida.
- Alerta Discord com top 3 pares e justificativa.

### 5.4 Frequência
- Scan completo: a cada 1 hora.
- Re-scan rápido: quando um par é removido ou regime muda.

---

## 6. Regime Detection e ajuste de seleção

O regime de mercado afeta a seleção de pares:

| Regime | Característica | Ajuste na seleção |
|---|---|---|
| **Calmo** (low vol) | Spread pequeno, baixa toxicidade | Priorizar pares com volume alto e fees baixos |
| **Volátil** (high vol) | Spread grande, alta toxicidade | Priorizar pares com book profundo e AS baixo. Reduzir N. |
| **Trending** (direcional) | Movimento unidirecional | Evitar pares com alta beta. Focar em pares neutros. |
| **Tóxico** (flash crash) | Spreads anômalos, liquidez evaporando | Halt em todos os pares. Cancelar ordens. |

**Detecção:** HMM/GARCH (fast layer, ms) + Gemini (slow layer, minutos).

---

## 7. Fluxo de seleção (passo a passo)

```
1. Obter lista de todos os pares da exchange (exchangeInfo)
2. Aplicar hard filters (min notional, volume, volatilidade, correlação, blacklist)
3. Para cada par restante:
   a. Calcular spread, volume, vol, fees, depth, AS
   b. Calcular score composto (2.7)
   c. Consultar RAG: edge histórico?
   d. Consultar Gemini: eventos relevantes?
4. Rankear por score composto (desc)
5. Selecionar top N (baseado em capital disponível)
6. Verificar correlação: se N_eff < 2, remover par mais correlacionado
7. Alocar capital (risk parity, max 40% por par)
8. Iniciar market making nos pares selecionados
9. Reavaliar a cada 1 hora (ou quando regime muda)
```

---

## 8. Implementação prática (código)

### 8.1 CoinSelectorService
```typescript
// Pseudo-código (não implementado ainda)
class CoinSelectorService {
    async selectBestPairs(capital: number, maxPairs: number): Promise<SelectedPair[]> {
        const allPairs = await exchangeInfo.getAllSymbols();
        const filtered = allPairs.filter(p => this.passesHardFilters(p, capital));
        const scored = await Promise.all(filtered.map(p => this.scorePair(p)));
        const ranked = scored.sort((a, b) => b.totalScore - a.totalScore);
        const selected = this.applyCorrelationFilter(ranked.slice(0, maxPairs));
        return this.allocateCapital(selected, capital);
    }
}
```

### 8.2 MultiPairOrchestrator
```typescript
// Pseudo-código (não implementado ainda)
class MultiPairOrchestrator {
    private engines: Map<string, MarketMakerEngine> = new Map();
    
    async rebalance(capital: number) {
        const selected = await coinSelector.selectBestPairs(capital, this.maxPairs);
        // Stop engines for removed pairs
        // Start engines for new pairs
        // Reallocate capital
    }
}
```

### 8.3 Prioridade de implementação

| # | Tarefa | Status |
|---|---|---|
| 1 | Hard filters (min notional, volume, volatilidade) | ❌ |
| 2 | Score composto multi-critério | ❌ |
| 3 | Correlation filter (N_eff) | ❌ |
| 4 | Risk parity allocation | ❌ |
| 5 | CoinSelectorService | ❌ |
| 6 | MultiPairOrchestrator | ❌ |
| 7 | IA Opportunity Scanner (Gemini) | ❌ |
| 8 | Regime-based selection adjustment | ❌ |
| 9 | Rebalanceamento automático (1h) | ❌ |
| 10 | Discord alert com top 3 pares | ❌ |

---

## 9. Limitações

1. **Com $1-$5:** Só 1 par (min notional). Sem diversificação real.
2. **Correlação alta em crypto:** Diversificação ajuda menos do que √N sugere.
3. **Overfitting do scanner:** IA pode overfit em padrões históricos. Usar walk-forward validation.
4. **Slippage em micro trades:** Pares com book raso podem ter slippage alto. Filtrar por depth.
5. **Taxas em DEX:** 0.3% swap fee pode comer o edge. Preferir CEX maker quando possível.

---

## 10. Resumo

> **A seleção de moeda é multi-critério e dinâmica.** O bot avalia todos os pares disponíveis, filtra os inviáveis, calcula um score composto (spread, volume, volatilidade, fees, depth, adverse selection), verifica correlação real, aloca capital por risk parity, e reavalia a cada hora. A IA (Gemini) atua como scanner de oportunidades no slow layer, consultando RAG memory e notícias.  
> **Com $1-$5, só 1 par é viável.** Com $20+, diversificação real começa. Com $100+, o farm completo (multi-pair + grid + sniper) pode operar.
