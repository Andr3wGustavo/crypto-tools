# Cortex Farm: plano mestre (US$15 · MEXC · backend de produção · VPS · dashboard Web3 estilo Revert)

> **Regra de execução:** a construção só começa com **"OK CLAUDE"** ou com a aprovação deste plano. A primeira ação é salvar essa regra na memória do projeto.
> Durante a execução eu atualizo `docs/PROGRESS.md` a cada item concluído e, **no final, entrego o checklist completo com a prova de cada item** (saída de testes, prints, logs).

## Contexto

Você quer uma **farm AFK que começa com US$15 e empilha os próprios lucros** (caixa + tesouro) com micro-trades de market making. O foco do projeto está em três frentes:
- **backend robusto**, pronto para rodar em **VPS**;
- **dashboard Web3** com a linguagem analítica do revert.finance;
- identidade **amarelo/preto**, com toda a lógica, a matemática, os logs e o PnL em tempo real.

Base da análise: li todo o código, os 14 docs, o `CONTEXT.md`, o ai-memory e o git; rodei `tsc` e pesquisei taxas, mínimos e APIs atuais. Ambiente local: Docker 29 + Compose v5, Node 24, WSL2 OK. Ainda faltam Tailscale e `gh`.

**Decisões fechadas:**
1. Repo fora do Dropbox (`C:\dev\crypto-tools`).
2. Farm MM primeiro.
3. Auto-withdraw com limites rígidos.
4. Capital inicial de **US$15**.
5. **MEXC** como corretora (maker 0% padrão, taker 0,05%, ordem mínima de ~1–5 USDT por par).
6. **Binance** só como sinal de preço.
7. Backend e VPS de nível produção desde o início.
8. Dashboard Web3 estilo Revert, amarelo/preto.

**Padrões que eu escolhi (troque o que quiser antes do OK):**
- **VPS:** Oracle Always Free em Tóquio (ARM, 2 OCPU/12 GB), com upgrade para Pay-As-You-Go, que continua US$0 e evita a recuperação de servidor ocioso. Plano B pago: Vultr/Linode/Lightsail Tóquio, ~US$5–6/mês.
- **Carteira Web3:** Solana/Phantom, para login e para o tesouro on-chain. EVM fica para depois.
- **Dados:** Postgres + TimescaleDB e Redis.
- **Acesso:** Tailscale (sem porta pública).

---

## 1. O que eu garanto, e o que ninguém garante

**Garanto, com prova no checklist final:**
1. Software funcionando: CI verde, testes em toda a matemática, replay determinístico e critério de "pronto" verificado em cada etapa.
2. Matemática correta, testada contra valores conhecidos (NIG analítico, δ* por otimização numérica, ledger batendo com a corretora).
3. **Perda máxima limitada no live:** `L_max ≈ loss_budget + cap_inventário × gap_extremo = US$3 + US$3 × 50% ≈ US$4,50`. Fica de fora só o risco da própria corretora (falência ou hack), que nenhum código controla.
4. Segurança:
   - modo padrão **shadow** (sem dinheiro);
   - live só com flag + 2FA;
   - kill switch testado;
   - chave de trading sem permissão de saque, com IP fixo e restrita aos pares escolhidos;
   - saques com 5 travas.
5. Medição honesta: decisão GO/NO-GO com 95% de confiança **antes** de arriscar dinheiro.
6. Dashboard ao vivo no PC e no celular. Trocar de VPS leva minutos (um comando de bootstrap).

**Ninguém pode garantir lucro.** Quem garante está mentindo; esse é o sinal nº 1 de golpe. O sistema garante a **resposta verdadeira** sobre o edge, com **perda limitada**.

---

## 2. Veredito

| Situação | Resposta |
|---|---|
| Código de hoje | ❌ Spread de ~129%, 0 fills |
| Binance spot (conta normal) | ❌ Perda garantida (maker 0,10% → 15–20 bps por round-trip) |
| **MEXC maker 0% + lead-lag da Binance + Tóquio + filtros + inventário pequeno** | ⚠️ Melhor configuração possível para retail. Edge positivo com chance de ~25–35% (estimativa minha) |
| "$1 ou $5 dobrando por dia" | ❌ Impossível (seção 3.5) |

---

## 3. Matemática refinada (US$15)

**3.1 Lucro por fill:** `δ − f − AS`. Na MEXC f = 0, então todo o jogo é manter **AS < δ** (AS = seleção adversa).

**3.2 Lead-lag entre corretoras (a arma principal):**
- Preço justo: `fair = mid_Binance × (1 + basis_EWMA)`.
- Se a Binance andar mais de X bps, o bot puxa ou desloca as cotações na MEXC antes de ser atropelado.
- O Pair Scanner prioriza pares listados nas duas corretoras.

**3.3 Cotação ótima (Avellaneda-Stoikov corrigido, em bps):**
- Taxa de execução: `λ(δ) = A·e^(−kδ)`, com A e k calibrados por par.
- Distância ótima: `δ* = c + 1/k`, com `c = AS`.
- Lucro esperado no ótimo: `π* = (A/k)·e^(−1−kc)·N`.
- Preço de reserva: `r = fair·(1 − q·γ·σ²·τ)`, com q ∈ [−1, 1].
- Limites de sanidade: entre 1 tick e 50 bps.

**3.4 Sizing para US$15:**
- Ordem = `max(1,1 × mínimo_do_par, 15% × equity)`, ou seja, ~US$2,25 com mínimo de 1 USDT.
- Teto de inventário: 1 lote ou 20% do equity.
- Começa 100% em USDT; no teto, só cota o lado que reduz o inventário.
- Viabilidade: se `caixa < 2 × mínimo + buffer`, o bot não opera e avisa.
- Pares com mínimo de 5 USDT ficam fora, a menos que o Scanner prove que compensam.

**3.5 Estimativas (US$15, ordem de US$2,25, 100 round-trips/dia, servidor de custo zero):**

| Cenário | Prob. (minha) | Edge/RT | Por dia | 30 dias | 1 ano (compound) |
|---|---|---|---|---|---|
| Pessimista | ~40–50% | −3 bps | −US$0,07 | NO-GO no shadow, custo US$0 | – |
| Neutro | ~25% | 0 ± 1 | ~0 | ~0 | ~US$15 |
| Otimista | ~25–30% | +2 bps | +US$0,045 | +US$1,40 | ~US$45 |
| Muito bom (raro) | ~5% | +5 bps | +US$0,11 | +US$3,80 | ~US$230 |

Tempo até US$100: `T = ln(100/15)/g`, cerca de 1,6 ano a 0,3%/dia. **Com US$15 o objetivo é provar o edge e deixar a máquina pronta para subir de degrau.**

**3.6 Validação do edge:**
- Modelo NIG sobre o PnL MTM por hora.
- GO se `P(μ > 1 bp) > 0,95`; NO-GO se `P(μ > 0) < 0,05`.
- Mínimo de 7 dias e 300 fills, com correção de Bonferroni.
- Isso dá ~1–2 semanas de shadow.

**3.7 Drawdown:** `P(DD ≥ 15%) ≈ exp(−2mB/σ²)`. Com μ = 0,3%/dia, reduzir σ de 2% para 1% leva esse risco de ~12% para ~0%. **Inventário pequeno é a principal proteção.**

**3.8 Caixa + Tesouro + escada de capital:**
- Três baldes: caixa (opera), tesouro (nunca opera, nunca cobre perda) e fila de saque.
- Divisão do lucro: ρ = 0,5 para o caixa, o resto para o tesouro.
- Promoção: quando o tesouro chega a k × C₀, metade dele vai para o caixa.
- Degraus de capital:
  - D0: shadow com US$15 virtuais;
  - D1: US$15 real após o GO;
  - D2: US$50;
  - D3: US$200+.
- Saque automático só com o tesouro acima de US$20, para a **carteira tesouro on-chain** (Solana).

---

## 4. Sugestões incorporadas

1. Shadow primeiro.
2. Lead-lag Binance → MEXC.
3. VPS grátis em Tóquio. Medir a latência para a MEXC (Tóquio ou Singapura) antes de fixar a região.
4. Penny quando o spread for ≥ 3 ticks; inventário com decaimento no tempo.
5. **Loss budget de US$3.**
6. Parâmetros pré-registrados por janela, com validação walk-forward.
7. Benchmark: bater o USDT parado.
8. Gravar todo o dado bruto de mercado.
9. Filtro anti-rug no Scanner.
10. Só US$15 na corretora, 2FA, chave com IP vinculado e pares restritos.

---

## 5. Backend de nível sênior (o coração técnico)

**5.1 Princípios de arquitetura:**
1. **Núcleo determinístico e puro** (`packages/core`): `decide(estado, evento) → ações`. É **o mesmo código em replay, shadow e live**; só o executor muda (`SimExecutor` ou `MexcExecutor`). Assim, o que foi validado é exatamente o que roda com dinheiro.
2. **Event log append-only** (event sourcing leve). Todo evento é versionado, persistido e reproduzível: `MarketTick`, `QuoteDecision`, `OrderIntent`, `OrderAck`, `Fill`, `RiskEvent`, `TreasuryMove`, `ConfigChanged`, `Command`. O estado é a dobra desses eventos, o que dá auditoria total e responde perguntas como "o que o bot pensou às 03:12?".
3. **Single-writer:** só o worker escreve o estado de trading. API e Discord enviam **comandos**; o worker valida e aplica. Sem condição de corrida.
4. **Máquina de estados de ordem:** `INTENT → SENT → NEW → PARTIAL → FILLED | CANCEL_REQ → CANCELED | REJECTED | UNKNOWN`. O `clientOrderId` é determinístico; o estado UNKNOWN é resolvido por consulta (idempotência sob retry ou crash).
5. **Contabilidade de dupla entrada:** cada fill gera lançamentos (USDT −, BASE +, taxa −), e o movimento caixa ↔ tesouro também é lançamento. Invariante testada: a soma é sempre 0, e o tesouro nunca fica negativo.
6. **Reconciliação contínua:** a cada N segundos, saldos e ordens da corretora são comparados com o estado interno. Divergência → pausa + alerta. **A corretora é a fonte da verdade.**
7. **Falha segura:** erro desconhecido → cancel all + pausa. Nunca "continua cotando".
8. **Hot path sem I/O bloqueante:** decisão em memória, persistência assíncrona em lote, guarda de event-loop lag (passou de 50 ms → puxa as cotações).
9. **Tempo:** relógio monotônico para TTLs, offset do servidor para assinar requisições, chrony no VPS.
10. **Rate limit** com token bucket ponderado por endpoint. A re-cotação tem histerese: só substitui a ordem se o preço mudou ≥ 1 tick, ≥ X bps ou o TTL venceu.
11. **Config versionada** (BotConfig v1, v2…) com janela de avaliação pré-registrada; toda mudança é um evento auditado.
12. **Bancos separados por modo** (`farm_shadow` e `farm_live`): é impossível misturar o ledger simulado com o real.

**5.2 Dados:**
- **Postgres 16 + TimescaleDB:** hypertables para equity, cotações e markouts; retenção e compressão automáticas; agregados contínuos de 1m/1h/1d alimentam o dashboard (24h/7d/30d).
- **Redis 7:** Streams com consumer groups para eventos, snapshots "latest", pub/sub para a UI, AOF ligado.
- **Dado bruto de mercado:** NDJSON.gz por hora e por par; 14–30 dias no disco, depois offload para object storage (Oracle 20 GB grátis ou Cloudflare R2 10 GB grátis).

**5.3 API:**
- Fastify + Zod, com contratos compartilhados com o front.
- OpenAPI gerado e cliente tipado para o front.
- WebSocket tipado no modelo snapshot + deltas (ao reconectar, o cliente recebe o snapshot), com throttle de ~4 Hz.
- Rate limit e CORS restrito.

**5.4 Auth Web3:**
- **Sign-In With Solana (Phantom):** nonce de uso único, domínio vinculado, expiração; a carteira do dono fica numa allowlist.
- **TOTP** para ações de risco.
- Sessão em cookie httpOnly SameSite=strict, guardada no Redis.
- Token de serviço com escopo para o bot do Discord.
- **As chaves da corretora vivem só no worker**; API e web nunca as veem.

**5.5 Testes (pirâmide completa):**
- Unitários no core.
- **Property-based** (fast-check): o ledger conserva valor, o tesouro nunca fica negativo, cotações nunca cruzam, tamanho sempre ≥ mínimo.
- Integração com Testcontainers (Postgres/Redis) e adapters rodando com fixtures gravadas da MEXC.
- Replay golden, com resultado idêntico bit a bit.
- E2E com Playwright.
- **Testes de caos** em staging: matar o worker no meio de uma ordem, derrubar o WS, forçar skew de relógio, deixar o Postgres fora.

**5.6 Observabilidade:**
- Logs pino em JSON com correlação (`cycleId`, `clientOrderId`).
- Métricas `/metrics` (prom-client): latência do WS, lag do event loop, ordens/min, rejeições, skew de relógio.
- Endpoints `/healthz` e `/readyz` (WS conectado, DB ok, skew < 500 ms, ticker fresco).
- **Dead-man externo** (healthchecks.io grátis), porque se o VPS morrer quem avisa precisa estar fora dele, mais alertas no Discord.

---

## 6. VPS e produção

**6.1 Servidor:**
- Oracle Always Free, Tóquio, ARM Ampere 2 OCPU/12 GB, o que comporta toda a stack.
- **Upgrade para PAYG** (continua US$0 dentro do Always Free) + alerta de orçamento de US$1. Motivo: a Oracle recolhe instâncias Always Free ociosas por 7 dias (CPU, rede ou memória abaixo de ~10–20%).
- A home region é **irreversível**: escolher Tóquio, ou Singapura se a latência para a MEXC for melhor.
- Plano B: Vultr, Linode ou Lightsail em Tóquio (~US$5–6/mês).

**6.2 Hardening:**
- Ubuntu 24.04 LTS, usuário não-root.
- SSH só por chave e só via Tailscale.
- `ufw` negando toda entrada, fail2ban, unattended-upgrades.
- **chrony** (NTP, crítico para assinar requisições), swap de 2 GB, rotação de logs do Docker.

**6.3 Rede:**
- **Nenhuma porta pública.** Dashboard via Tailscale (HTTPS com `tailscale serve` e MagicDNS).
- Se um dia for público: Cloudflare Tunnel + Cloudflare Access, sem abrir portas.
- **IP público reservado (fixo)**, usado para vincular a chave da MEXC. Uma chave com IP vinculado não expira; sem IP, expira em 90 dias.

**6.4 Containers:**
- `docker compose` com perfis `shadow` e `live`.
- Healthchecks, `restart: unless-stopped`, `stop_grace_period: 30s` (no SIGTERM o worker cancela as ordens).
- Limites de memória, rede interna; Postgres e Redis sem porta exposta.

**6.5 Imagens:**
- Multi-stage, Node 24 LTS slim, usuário não-root.
- **Multi-arch arm64 + amd64** (buildx), porque o Ampere é ARM.
- Engine do Prisma compatível com linux-arm64; Next.js com `output: 'standalone'`.

**6.6 CI/CD (GitHub Actions):**
1. lint, typecheck e testes;
2. build das imagens e push para o GHCR privado, com tag = SHA do commit;
3. deploy via Tailscale + SSH: `compose pull && up -d`;
4. smoke test em `/readyz`;
5. **rollback automático** para a tag anterior se falhar.

O deploy do worker faz **drain** antes: pausa → cancel all → troca → retoma.

**6.7 Segredos:**
- `.env` nunca vai para o git. No VPS fica com permissão 600 ou em Docker secrets.
- Opcional: sops + age para versionar segredos criptografados.
- Chaves da corretora só dentro do container do worker.

**6.8 Backups:**
- `pg_dump` diário com retenção de 14 dias, cópia off-site criptografada (age).
- **Teste de restauração mensal.**

**6.9 Portabilidade:**
- `infra/bootstrap.sh` (cloud-init) deixa um Ubuntu limpo pronto com um comando, então trocar de VPS leva minutos.
- Runbooks em `docs/runbooks/`: kill switch, restore, rotação de chaves, queda da corretora, deploy/rollback, servidor morto.

**Estrutura do monorepo:**
```
apps/      worker · api · web · discord
packages/  core (matemática pura) · exchange (MexcAdapter WS protobuf + BinanceAdapter) · db (Prisma) · shared (Zod)
infra/     compose.yaml (perfis) · Dockerfiles multi-arch · bootstrap.sh · backup/ · runbooks
```

---

## 7. Dashboard Web3 (linguagem do Revert, identidade própria amarelo/preto)

**Mapeamento Revert (LP) → nossa farm (MM).** Market making é uma "LP ativa", então os conceitos se traduzem 1:1:

| Revert | Nossa farm |
|---|---|
| Posição LP | Bot (par) |
| Range de preço | Banda de cotação em torno do preço justo |
| In range / out of range | Cotando / pausado |
| Fees earned | Spread capturado |
| Impermanent loss / LVR | Seleção adversa + MTM do inventário |
| APR | APR anualizado (realizado e MTM) |
| Backtester | Simulador com replay dos dados gravados |

**Visual Web3:**
- Fundo `#0A0A0B` com textura sutil (grid/noise); cards *glass* `#121214`/`#1A1A1D`, `rounded-2xl`, bordas `#26262B`.
- **Amarelo `#FFD60A`** com glow sutil; PnL em verde `#22C55E` e vermelho `#EF4444`.
- Inter + JetBrains Mono (números tabulares), números animados (count-up).
- Botão **Connect Wallet** (Phantom) no topo, badge de rede, chip de endereço com copiar + link no Solscan.
- Ícones de token, pills de período, skeleton loaders, toasts. **Mobile-first.**
- Sem copiar logo, nome ou cores do Revert: só a linguagem analítica.

**Stack:** Next.js + React 19 + Tailwind v4 + shadcn/ui + Framer Motion, TanStack Query, Zustand, `@solana/wallet-adapter`, TradingView Lightweight Charts, ECharts, KaTeX.

| Página | Conteúdo |
|---|---|
| **Overview** | Equity, PnL 24h/7d/30d (realizado/MTM), APR, curva de equity, drawdown, **cards de "posição" por bot** (estilo Revert: par, banda, status, spread capturado, AS, APR, sparkline), gauge P(μ>0), alertas |
| **Bot → Detalhe** | Gráfico ao vivo (mid MEXC + mid Binance + banda de cotação + fills), book, inventário, **cascata de PnL**, fill rate, latência, parâmetros e histórico, controles |
| **Edge Lab** | Posterior de μ, GO/NO-GO, curva λ(δ) com δ*/π*, markouts, lead-lag, calculadora de drawdown, Monte Carlo do compound, fórmulas KaTeX ao vivo |
| **Simulador** | Replay/backtest com dados gravados: escolher par, período e parâmetros → curva de PnL e comparação com o shadow |
| **Pair Scanner** | Ranking por π* com filtro anti-rug → "colocar em shadow" |
| **Caixa e Tesouro** | Os 3 baldes ao vivo, degrau da escada e progresso, `T = ln(meta/C₀)/g`, **tesouro on-chain** (saldo da carteira Solana via RPC, saques com link no Solscan), status das 5 travas |
| **Risk Center** | Limites, halts, incidentes, **KILL SWITCH** |
| **Fills e Ordens** | Ledger com filtros + CSV |
| **Logs** | Stream ao vivo com filtro e busca |
| **Sistema** | CPU/RAM/disco, containers, latência até MEXC/Binance, skew de relógio, lag do event loop, último backup, versão em deploy |
| **Settings** | Modo, status das chaves (sem segredos), carteiras autorizadas, 2FA, Discord |

---

## 8. Status: **20 / 100**

| Área | Peso | Hoje |
|---|---:|---:|
| Repo, infra e VPS | 10 | 2 |
| Dados de mercado e execução | 11 | 4 |
| Estratégia e cotação | 11 | 2 |
| Contabilidade e tesouro | 10 | 2 |
| Risco | 10 | 2 |
| Validação de edge | 11 | 2 |
| API e auth Web3 | 8 | 0 |
| Dashboard Web3 | 14 | 0 |
| Scout, IA e Discord | 6 | 4 |
| Testes, CI e observabilidade | 9 | 2 |
| **Total** | **100** | **20** |

**Nota ao fim de cada etapa:** E0 22 · E1 30 · E2 42 · E3 52 · E4 58 · E5 64 · E6 80 · E7 86 · E8 90 · E9 93 · E10 100.

---

## 9. Execução + checklist

Tamanho: P / M / G. O gargalo de calendário são as 1–2 semanas de shadow, que começam na E4; o dashboard é construído enquanto os dados acumulam.

### E0: Resgate do repo (P) → 22
- [ ] Salvar a regra "OK CLAUDE" na memória; criar `C:\dev` e `docs/PROGRESS.md`
- [ ] Zip de backup → clonar o GitHub `2d9c5a5` em `C:\dev\crypto-tools` → copiar `.env` e `CONTEXT.md` → renomear a pasta antiga para `_OLD_corrupted`
- [ ] `npm ci` → `prisma generate` → `tsc --noEmit` com 0 erros → commit
- **Prova:** `git status` limpo + saída do tsc

### E1: Fundação e infra local (M) → 30
- [ ] Monorepo (seção 6), migrando o código existente sem perda
- [ ] `infra/compose.yaml` local: Postgres + TimescaleDB, Redis; Dockerfiles multi-arch; scripts `make up/test/build`
- [ ] Schema:
  - tabela `events` (append-only);
  - **ledger de dupla entrada** (`Account`, `Entry`);
  - `Order` (FSM + clientOrderId), `Fill`, `EquitySnapshot` (hypertable), `QuoteSample`, `Markout`;
  - `TreasuryLedger`, `CapitalStage`, `EdgeState`, `RiskEvent`, `Withdrawal`, `BotConfig` (versionada), `AuditLog`, `LogEntry`;
  - modelos de token atuais mantidos.
- [ ] Config segura: `TRADING_MODE=shadow|live` (padrão shadow), booleanos estritos, Zod falha alto
- [ ] Logger pino; Vitest + fast-check; GitHub Actions (lint, tsc, testes, build das imagens)
- **Prova:** CI verde + `docker compose up` saudável

### E2: Mercado, execução e shadow (G) → 42
- [ ] `ExchangeAdapter`. **MexcAdapter**:
  - REST v3 assinado;
  - WS protobuf (`wss://wbs-api.mexc.com/ws`, protos oficiais), reconexão de 24h, assinatura em menos de 30s;
  - rate limit, `newClientOrderId`, sync de relógio, exchangeInfo.
- [ ] **BinanceAdapter** de market data
- [ ] Watchdogs de WS + guarda de ticker velho
- [ ] Core: `decide(estado, evento)`; preço justo + basis; filtro lead-lag; cotação δ*/skew com limites e assert; penny; regras de inventário
- [ ] FSM de ordens + single-writer + fila de comandos + event log
- [ ] **SimExecutor (shadow):** fill quando um trade cruza a cotação, fila conservadora, latência simulada
- [ ] Gravador NDJSON.gz + replay
- [ ] Testes: unitários, property-based e replay golden
- **Prova:** o replay de 1h reproduz fills e PnL bit a bit

### E3: Contabilidade, tesouro e risco (M) → 52
- [ ] Lançamentos de dupla entrada por fill (parciais, taxa convertida), PnL realizado + MTM, reconciliação contínua
- [ ] **Treasury + CapitalLadder** com regra de viabilidade
- [ ] `RiskManager` em todo ciclo:
  - drawdown, daily stop, teto de inventário, **loss budget de US$3**;
  - taxa de erro, ticker velho, lag do event loop;
  - qualquer violação → kill switch.
- [ ] Shutdown com drain, handlers de crash, reconciler de boot, estado persistido
- [ ] Property tests do ledger e do tesouro; testes de cada regra de risco
- **Prova:** relatório de testes + kill/restart com o equity batendo

### E4: VPS de produção + shadow 24/7 (M) → 58 (o relógio de 1–2 semanas começa aqui)
- [ ] `bootstrap.sh`: hardening, chrony, Docker, Tailscale, swap
- [ ] Oracle PAYG + alerta de orçamento + IP reservado
- [ ] Medir latência MEXC/Binance (Tóquio vs. Singapura)
- [ ] CD: GHCR + deploy via Tailscale + smoke test + rollback; drain do worker
- [ ] Backups off-site criptografados + **teste de restauração**; dead-man externo; runbooks
- [ ] **Testes de caos** em staging
- [ ] Shadow nos 5–10 melhores pares com tesouro virtual de US$15
- **Prova:** 24h de shadow sem intervenção + restauração de backup testada + rollback testado

### E5: API e auth Web3 (M) → 64
- [ ] Fastify + Zod + OpenAPI + cliente tipado; WS com snapshot + deltas
- [ ] **Sign-In With Solana** (Phantom, allowlist) + TOTP em ações de risco; sessão no Redis; token de serviço para o Discord; AuditLog
- [ ] Comandos: start, pause, stop, flatten, parâmetros validados, kill switch
- [ ] `/metrics`, `/healthz`, `/readyz`
- **Prova:** testes de integração; carteira fora da allowlist e comando sem auth são recusados

### E6: Dashboard Web3 (G) → 80
- [ ] Design system amarelo/preto Web3 (tokens, glass, componentes, mobile-first)
- [ ] Connect Wallet (Phantom), cards de "posição" estilo Revert
- [ ] Páginas: Overview, Bot/Detalhe, Caixa e Tesouro (tesouro on-chain), Risk Center, Fills, Logs, Sistema, Settings
- [ ] Tempo real; estados de carregando, vazio e desconectado
- [ ] Playwright + revisão visual por screenshot
- **Prova:** prints ao vivo no PC e no celular via Tailscale

### E7: Edge Lab, Simulador e Pair Scanner (M) → 86
- [ ] Fit de A e k, π*, markouts, lead-lag, NIG por hora, GO/NO-GO, Monte Carlo, KaTeX ao vivo
- [ ] Simulador de replay/backtest
- [ ] Scanner com anti-rug
- **Prova:** os números batem com o cálculo independente dos testes; o replay no Simulador bate com o shadow

### E8: Live controlado (P) → 90
- [ ] Chave MEXC **só de trade**, com IP do VPS vinculado e **pares restritos**
- [ ] Ordens mínimas longe do preço (não executam) → cancelar → reconciliar → idempotência sob crash
- [ ] Um ciclo real mínimo supervisionado (~US$1–2)
- **Prova:** 24h sem divergência entre a corretora e o DB

### E9: Auto-withdraw com limites rígidos (M) → 93
- [ ] Chave MEXC separada **só de saque**, com IP vinculado
- [ ] Destino = **carteira tesouro Solana** na whitelist da conta
- [ ] Mínimo = max(US$20, mínimo da rede + taxa); 1 saque por dia; teto diário
- [ ] Só lucro confirmado contra o equity real; nunca em halt, drawdown ou reconciliação pendente
- [ ] FSM `PENDING → SENT → CONFIRMED/FAILED` + lock + reserva debitada antes e restaurada em caso de falha; bloqueado em shadow
- **Prova:** testes dos 5 bloqueios + o saque aparecendo no card on-chain do dashboard

### E10: GO/NO-GO e live US$15 → 100
- [ ] Revisão no Edge Lab (≥7 dias, ≥300 fills, P(μ > 1 bp) > 0,95)
- [ ] **GO:** live com US$15 e loss budget de US$3; live comparado com shadow; escada D2/D3 automática
- [ ] **NO-GO:** novo par ou novos parâmetros pré-registrados e repetir o shadow, ou encerrar com custo zero
- **Prova:** relatório do Edge Lab + **checklist final entregue a você**

### Depois: Discord e Scout
- [ ] Bot do Discord via API (alertas + comandos com permissão)
- [ ] Scout: dedupe, fail-closed, APIs atualizadas, anti-prompt-injection, página Scout

**Ao fim de cada sessão:** `docs/PROGRESS.md` atualizado + commit/push + handoff no ai-memory.

---

## 10. O que vou precisar de você (só na hora certa)

| Quando | O quê |
|---|---|
| E4 | Conta Oracle Cloud (cartão para verificação; home region **Tóquio**, irreversível) + upgrade PAYG; conta Tailscale; instalar Tailscale no PC e no celular |
| E4 | Conta grátis no healthchecks.io (dead-man) |
| E5/E6 | Endereço da sua carteira Phantom (login e tesouro); token do bot do Discord |
| E8 | Conta MEXC com KYC + 2FA; chave de trading (sem saque, IP do VPS, pares restritos); depósito de US$15 |
| E9 | Chave MEXC só de saque + endereço do tesouro na whitelist |

---

## 11. Diagnóstico técnico (resumo do que o plano elimina)

- `.git` corrompido pelo Dropbox; 59 erros de TS no working tree (o GitHub `2d9c5a5` está bom).
- Spread de 129% ([market-maker.engine.ts:198-205](src/modules/trading/market-maker.engine.ts#L198-L205)), taxa errada, inventário fixo, trava permanente no gate.
- Edge enviesado (só ciclos completos, sem parciais, taxa em ativos misturados, sem persistência).
- Risco cosmético (halt e daily stop não aplicados, shutdown deixa ordens abertas, ticker velho não detectado).
- Auto-withdraw tratando USDT como SOL, com risco de saque duplo.
- Sem clientOrderId, sync de relógio ou minNotional; catraca no tamanho de ordem; 7 PrismaClients; `z.coerce.boolean("false") = true`.
- Scout fail-open, prompt injection, `/mm` sem permissão, APIs antigas, zero testes/CI, docs contraditórios.

---

## 12. Verificação final (definição de 100/100)

1. CI verde: tsc + Vitest (core ≥ 90% de cobertura) + property tests + Playwright.
2. Replay determinístico reproduz fills e PnL.
3. Testes de caos passam; kill switch age em < 1s.
4. Deploy com rollback automático e restauração de backup testados no VPS.
5. 24h de live controlado sem divergência entre corretora e DB.
6. Dashboard Web3 ao vivo no celular, com login Phantom + TOTP e auditoria.
7. Shadow com ≥7 dias e ≥300 fills → decisão GO/NO-GO documentada.
8. (Se GO) live com US$15 dentro do loss budget e coerente com o shadow.
9. **Checklist final entregue com a prova de cada item.**
