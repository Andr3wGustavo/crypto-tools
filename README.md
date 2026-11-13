# Cortex Crypto Sentinel

Infraestrutura modular em TypeScript para **inteligência e trading cripto automatizado**. Unifica radar DEX, auditoria anti-honeypot, due diligence por IA, market making adaptativo na Binance, compound de lucros e terminal Discord — tudo operando AFK (away from keyboard).

---

## O que faz

| Módulo | O que faz |
|---|---|
| **Scout DEX** | Ingestão em tempo real da DexScreener (perfis novos, boosts, lookups em lote) |
| **Segurança on-chain** | GoPlus (EVM) + RugCheck (Solana): honeypot, taxas, mint/freeze authority, liquidez travada |
| **Filtros heurísticos** | Liquidez, volume, idade, anomalia FDV/liquidez (>200:1 rejeitado) |
| **IA Due Diligence** | Análise estruturada (score 0-100, scam/gem, riscos) com fallback quantitativo |
| **Memória RAG** | Embeddings 768 dims (text-embedding-004) + busca por similaridade de cosseno no SQLite |
| **Macro** | Fear & Greed Index + preços BTC/ETH na Binance |
| **Market Maker** | WebSocket @bookTicker (sub-50ms), volatilidade "Respiro", skew Avellaneda-Stoikov, ordens LIMIT_MAKER, drift-cancel, stop-loss diário |
| **Compound** | Reinveste lucros dos ciclos Maker. Split 50/50 (reinvest/reserva). Cap + drawdown limit + halt. Persiste capital no SQLite |
| **Auto-Withdraw** | Quando reserva protegida ≥ threshold, envia lucro para carteira (Solana transfer ou Binance withdraw). Reset reserva |
| **Gain Tracker** | PnL em tempo real, trailing stop a partir do pico, marcos 2x/5x/10x |
| **Terminal Discord** | 8 slash commands + botões interativos + alertas automáticos |
| **Seleção de moeda** | Scoring multi-critério (spread, volume, volatilidade, fees, depth, adverse selection). IA como scanner de oportunidades. Rebalanceamento a cada 1h |

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                    CORTEX CRYPTO SENTINEL                    │
├──────────────────────┬──────────────────────────────────────┤
│   SCOUTING & SECURITY│         TRADING & EXECUTION          │
│  - DexScreener Radar │  - Binance Adaptive Market Maker     │
│  - GoPlus / RugCheck │  - Low-Latency WS @bookTicker       │
│  - Multi-Stage Filter│  - Avellaneda-Stoikov Skew          │
│  - AI Due Diligence  │  - Compound Engine (reinvest+skim)  │
│  - RAG Memory (SQLite)│  - Auto-Withdraw (profit to wallet) │
│  - Macro Market Hub  │  - Gain Tracker (trailing stop)     │
├──────────────────────┴──────────────────────────────────────┤
│              DISCORD TERMINAL (8 commands + buttons)        │
│         AFK: PM2 auto-restart, heartbeat, dead-man timer     │
└─────────────────────────────────────────────────────────────┘
```

---

## IA configurável

O motor de IA é **configurável** — não está preso a um provider:

| Provider | Uso | Config |
|---|---|---|
| **Google Gemini** (padrão) | Due diligence, embeddings, regime analysis | `GEMINI_API_KEY`, `GEMINI_MODEL` |
| **Claude (Anthropic)** | Alternativa para due diligence e análise | `ANTHROPIC_API_KEY` (opcional) |
| **Heurístico** | Fallback quantitativo quando IA offline | Automático |

A IA **não trade diretamente** — ela gerencia: regime detection, edge estimation, opportunity scanning, risk management.

---

## Quick Start

```bash
# 1. Instalar dependências
npm install

# 2. Configurar ambiente
cp .env.example .env
# Edite .env com suas chaves

# 3. Sincronizar banco
npm run db:push

# 4. Desenvolvimento (hot-reload)
npm run dev

# 5. Produção
npm run build
npm start

# 6. AFK (auto-restart)
pm2 start ecosystem.config.js
```

---

## Configuração (.env)

### Essenciais

| Variável | Descrição | Default |
|---|---|---|
| `DATABASE_URL` | SQLite connection | `file:./prisma/dev.db` |
| `DISCORD_TOKEN` | Discord Bot token | (obrigatório para Discord) |
| `DISCORD_CLIENT_ID` | Discord Application ID | (obrigatório) |
| `GEMINI_API_KEY` | Google Gemini API key | (opcional, fallback disponível) |

### Trading (Binance)

| Variável | Descrição | Default |
|---|---|---|
| `BINANCE_API_KEY` | Binance API Key | (obrigatório para MM) |
| `BINANCE_SECRET` | Binance API Secret | (obrigatório para MM) |
| `BINANCE_TESTNET` | Usar testnet | `false` |
| `MM_SYMBOL` | Par de trading | `BTCUSDT` |
| `MM_MIN_ORDER_USD` | Tamanho mínimo da ordem | `15.0` |
| `MM_MAX_ORDER_USD` | Tamanho máximo da ordem (cap) | `200.0` |
| `MM_DAILY_STOP_LOSS` | Stop-loss diário | `-0.015` (-1.5%) |
| `MM_DRIFT_THRESHOLD` | Cancela ordens se mid mover mais que | `0.002` (0.2%) |

### Tesouro & saque automático (E9)

O lucro confirmado (realizado **e** confirmado pelo equity real) é dividido: 50% fica no caixa e
compõe, 50% vai para o tesouro, que nunca opera. O tesouro sai para **uma** carteira Solana na
whitelist da MEXC, só pelo processo separado `withdrawer`, com 5 travas. Ver `.env.example`
(bloco E9) e `docs/runbooks/vps.md` §6d.

| Variável | Descrição | Default |
|---|---|---|
| `WITHDRAW_ADDRESS` | Carteira tesouro Solana (precisa estar na whitelist da MEXC) | (vazio = sem saque) |
| `WITHDRAW_NETWORK` | Nome exato da rede na MEXC (USDT em Solana) | — |
| `WITHDRAW_MIN` / `WITHDRAW_DAILY_CAP` | Mínimo (≥ 20) e teto diário (≤ 1000) | `20` / `100` |
| `WITHDRAW_CHANNEL_SECRET` | Segredo HMAC entre live e withdrawer (≥ 32 chars) | — |

### Solana DEX (opcional)

| Variável | Descrição | Default |
|---|---|---|
| `SOLANA_RPC_URL` | RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `SOLANA_PRIVATE_KEY` | Private key (base58) | (vazio = desabilitado) |
| `DEX_AUTO_BUY_ENABLED` | Auto-buy de gems | `false` |
| `DEX_MIN_AI_SCORE` | Score mínimo para auto-buy | `90` |

---

## Comandos Discord

| Comando | Descrição |
|---|---|
| `/analyze <address>` | Auditoria de segurança + IA em qualquer token |
| `/ask <query>` | Consulta semântica à memória RAG |
| `/track <address> <entry_price>` | Rastrear posição com trailing stop |
| `/swap <mint> [amount_sol]` | Simular swap via Jupiter |
| `/radar` | Estatísticas do radar (tokens, gems, scams) |
| `/market` | Macro (Fear & Greed, BTC, ETH) |
| `/mm [status\|start\|stop]` | Controlar market maker |
| `/gains` | Posições ativas e PnL |
| `/compound` | Capital, profit, drawdown, edge, shouldTrade |

---

## Documentação

| Arquivo | Conteúdo |
|---|---|
| `docs/status.md` | Checklist de milestones e pendências |
| `docs/auto-farm-afk.md` | Lógica, fórmulas, arquitetura, IA, insights |
| `docs/coin-selection.md` | Estratégia de seleção de moeda/pares |
| `docs/action-plan.md` | Resumo de ação, config, comandos |

---

## Licença

ISC. Projetado para análise quantitativa e automação algorítmica.<|end|><|start|>write to=assistant<|channel|>analysis<|message|>Wrote file successfully: README.md