# Runbook — VPS de produção (E4)

Alvo: Oracle Cloud **Ampere A1** (arm64), Ubuntu 24.04, home region **Tóquio** (`ap-tokyo-1`).
Tudo roda em Docker; o único acesso de operador é o **Tailscale SSH** (sem porta 22 pública).

```
VPS ── tailscale ── seu PC / celular
 └─ docker compose (projeto cortex-farm)
     ├─ cortex-postgres (TimescaleDB)   ├─ cortex-redis
     ├─ cortex-worker-<par> × N         (1 processo por par: isolamento total)
     └─ cortex-deadman                  → healthchecks.io (alerta se algo parar)
/srv/cortex/
  repo/        clone do GitHub (deploy faz checkout do commit exato)
  data/market  gravações + snapshots  ← fonte da verdade (backup off-site cifrado)
  data/health  heartbeats dos workers
  cortex.env   segredos (chmod 600, nunca no git)
  deploy/      tag atual, histórico, lock
```

## 1. Criar o VPS (você, no console da Oracle)

1. Conta Oracle Cloud com home region **Japan East (Tokyo)** — a região não pode ser trocada depois.
2. Upgrade para **Pay As You Go** (o Always Free continua grátis; o PAYG evita que a Oracle recupere instâncias ociosas). Crie um **budget alert** de US$1.
3. Compute → Create instance → Image **Ubuntu 24.04** (aarch64), Shape **VM.Standard.A1.Flex** 2 OCPU / 12 GB (cabe no free tier, 4/24 é o teto).
4. Rede: VCN padrão com IP público (**reservado**, para não mudar), sua chave SSH pública.
5. Se der "Out of capacity": tente outro Availability Domain ou repita mais tarde (comum no A1).

## 2. Bootstrap (uma vez)

```bash
ssh ubuntu@<ip-publico>
curl -fsSL https://raw.githubusercontent.com/Andr3wGustavo/crypto-tools/rebuild/cortex-farm/infra/prod/scripts/bootstrap.sh -o bootstrap.sh
less bootstrap.sh                                   # leia antes de rodar
sudo TS_AUTHKEY=tskey-auth-XXXX bash bootstrap.sh   # chave em login.tailscale.com → Settings → Keys
```

Ele faz: atualizações automáticas de segurança, swap de 2 GiB, chrony (NTP da Oracle), Docker + rotação de logs, usuário `cortex`, SSH só com chave e sem root, fail2ban, Tailscale com SSH, `/srv/cortex`, `cortex.env` com senha aleatória do Postgres e backup de hora em hora.

Depois:
1. Do PC: `tailscale ssh cortex@cortex-tokyo` funciona? **Só então** remova a regra de ingress da porta 22 na Security List da VCN.
2. `nano /srv/cortex/cortex.env` → preencha `HEALTHCHECK_URL` (check "cortex-farm", período 5 min, tolerância 5 min) e `HEALTHCHECK_BACKUP_URL` (check "cortex-backup", período 1 h, tolerância 30 min).
3. Backup off-site: `rclone config` (como `cortex`) → crie o remote do provedor (Oracle Object Storage, Backblaze B2 ou Cloudflare R2) e, por cima dele, um remote **crypt** chamado `cortex-crypt`. Guarde a senha do crypt no seu gerenciador de senhas: **sem ela o backup é irrecuperável**.
4. `/srv/cortex/repo/infra/prod/scripts/latency.sh` → anote os números em `docs/PROGRESS.md`.
5. GHCR: na primeira vez, em github.com → Packages → `cortex-worker` e `cortex-migrate` → Package settings → **Public** (a imagem não contém segredos; o repositório já é público). Assim o VPS faz pull sem token.

## 2b. API do operador (E5): login com Phantom + TOTP

A API nunca vê chaves da corretora. Ela só autentica você e enfileira comandos (`pause`, `resume`, `reset_halt`, `reset_kill`) no stream do worker. O worker grava cada comando como input, então o replay continua bit-exato.

1. **TOTP** (no PC, no repo): rode `npx tsx apps/api/src/provision.ts totp`.
   - Cole o `otpauth://` no seu app autenticador (Aegis, 1Password, Google Authenticator).
   - Coloque `API_TOTP_SECRET=…` no `cortex.env`.
   - O segredo nunca vai para o git nem para o chat.
2. **Carteira:** `API_ALLOWED_WALLETS=<seu endereço Phantom>`. O endereço é público, não é segredo; vários vão separados por vírgula.
3. **Origem:** `API_ORIGIN=https://cortex-tokyo.<seu-tailnet>.ts.net`.
4. **Discord (opcional):** `npx tsx apps/api/src/provision.ts service discord pause+read`.
   - O token vai para o bot.
   - A linha com o hash vai em `API_SERVICE_TOKENS`.
   - Com isso, o bot pode pausar, mas nunca retomar.
5. **Ativar:** `COMPOSE_PROFILES=api` no `cortex.env`, depois deploy.
6. **HTTPS só no tailnet:** `sudo tailscale serve --bg --https=443 http://127.0.0.1:8080`. A porta 8080 fica presa no loopback do host.

**Regras de segurança**, todas com teste em `apps/api/src/app.test.ts`:

| Regra | Como funciona |
|---|---|
| Nonce | uso único, expira em 5 min, consumido antes de qualquer outra checagem |
| Mensagem vinculada | o domínio, a URI e o horário da mensagem assinada também ficam presos ao nonce |
| Allowlist | carteira fora dela é recusada, e a resposta não diz por quê (o motivo vai para o AuditLog) |
| Sessão | cookie `httpOnly; Secure; SameSite=Strict`, válido por 12 h; o servidor guarda só o hash do token |
| CSRF | comandos via cookie só são aceitos vindos da própria origem |
| `pause` | só exige a sessão: parar sempre tem que ser fácil |
| `resume` e `reset_*` | exigem TOTP de uso único, mesmo com duas requisições simultâneas; o worker recusa se o comando ficar parado mais de 2 min no stream |
| Revogação | tirar a carteira da allowlist derruba as sessões dela na próxima requisição |
| Rate limit | rotas de login: 10/min por IP; comandos: 30/min |
| Auditoria | todo login, recusa e comando é gravado no `AuditLog` |

## 3. Escolher os pares (pré-registro)

No VPS (ou no PC), **antes** de iniciar a janela de shadow:

```bash
docker run --rm -v /srv/cortex/data:/data ghcr.io/andr3wgustavo/cortex-worker:<tag> \
  node dist/scan.js --minutes 60 --every 5000 --top 8 --out /data/scans
npx tsx apps/worker/src/ops/pairs-cli.ts <scan.json>      # no PC, no repo (recusa se o core/engine tiver mudança não commitada)
git add infra/prod/pairs.json infra/prod/compose.pairs.yaml infra/prod/protocol.json && git commit && git push
```

O commit é o pré-registro. A seleção, o `paramsHash` do scanner e o **protocolo de GO/NO-GO** (`protocol.json`) ficam datados **antes** dos dados que vão julgá-los. O protocolo fixa:
- os pares (m);
- a regra (`DEFAULT_EDGE_PROTOCOL_RULE`);
- o instante de registro;
- o **fingerprint do código julgado**: hash do conteúdo de `packages/core/src` + `apps/worker/src/engine`, sem os testes e sem diferença de CRLF.

O arquivo tem hash, então qualquer edição posterior é detectada. Os pares não são trocados durante a janela (trocar = nova janela).

### A regra (master plan §3.6, fechada antes da janela)

| Item | Valor |
|---|---|
| Observação | retorno MTM do equity por janela de 1 h, em bps (inventário incluído, sem viés de sobrevivência) |
| Olhadas | **só** em 7, 14 e 21 dias, cada uma sobre exatamente o seu intervalo (rodar o avaliador mais vezes não muda nada) |
| GO do par i | P(μᵢ > 1 bp/h) ≥ 1 − 0,05/(m·3) **e** ≥ 300 fills na olhada |
| NO-GO antecipado | P(μᵢ > 0) < 5% (futilidade) |
| Autocorrelação | variância inflada por (1+ρ)/(1−ρ) quando ρ > 0 (o inventário carrega de uma hora para a outra) |
| Qualidade | olhada com > 5% do tempo sem dados não decide; na última olhada, tudo que não é GO vira NO-GO |
| Par sem dados | NO-GO após registro + 21 dias + 24 h |
| Troca de config na janela | violação ⇒ NO-GO daquele par |
| Live D1 | o par GO com o maior limite inferior corrigido |

Garantia (testada por simulação em `edge-protocol.test.ts`): a chance de **algum** par ser declarado GO, em **alguma** olhada, quando nenhum tem edge acima de 1 bp/h, é ≤ 5%. Medido: 1,7% com 8 pares; **sem a correção seria 28%**. Com inventário autocorrelacionado (ρ = 0,5): 4,5% com o ajuste e 20% sem ele.

O que a janela consegue provar, com σ ≈ 10 bps/h e 8 pares: um GO na 1ª olhada precisa de média ≈ 3,2 bps/h, e na 3ª de ≈ 2,3 bps/h (`minimumDetectableEdge`). Edges reais mas menores que isso terminam em NO-GO. **Isso é proposital**: protege o capital, a um custo de US$0.

## 4. Deploy

- Automático pelo GitHub: Actions → **Deploy (VPS)** → Run workflow → tag (12 primeiros caracteres de um commit com CI verde). Requer os secrets `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` (OAuth client do Tailscale com a tag `tag:ci`) e a variável `VPS_HOST=cortex-tokyo`.
- Manual: `tailscale ssh cortex@cortex-tokyo /srv/cortex/repo/infra/prod/scripts/deploy.sh <tag>`.

O `deploy.sh`: checkout do commit → pull → `migrate` → recria os containers → espera **todos** os healthchecks (heartbeat novo, da versão nova, com feed da MEXC vivo) → se algo não sobe em 5 min, **volta sozinho para a tag anterior** e sai com erro. Os workers drenam no SIGTERM (snapshot final) e retomam exatamente no boot: um deploy não perde estado.

Regra para migrations: só **aditivas** (expand/contract). Assim o rollback de código continua compatível com o schema.

## 5. Operação

| Quero… | Comando (como `cortex`) |
|---|---|
| Ver status | `docker ps --format 'table {{.Names}}\t{{.Status}}'` |
| Logs de um par | `docker logs -f --since 10m cortex-worker-dotusdt` |
| Saúde da fazenda | `docker logs --tail 5 cortex-deadman` |
| Heartbeats | `cat /srv/cortex/data/health/*.json \| jq -c '{symbol,status,records,fills,equity,mexcAgeMs}'` |
| Reiniciar um par | `docker restart cortex-worker-dotusdt` (drain + restore exato) |
| Replay / verificação | `docker run --rm -v /srv/cortex/data:/data:ro ghcr.io/andr3wgustavo/cortex-worker:<tag> node dist/verify-run.js /data/market/mexc-DOTUSDT/cfg-<hash12>` |
| Histórico de deploys | `cat /srv/cortex/deploy/history` |

## 6. Testes obrigatórios da E4

1. **Restauração de backup**: `infra/prod/scripts/restore-test.sh` → baixa o backup cifrado, roda `verify-run` em cada run (genesis = snapshot + cauda) e restaura o dump do Postgres num container descartável. Tem que terminar com `RESTORE TEST PASSED`.
2. **Rollback**: dispare o deploy de uma tag cujo worker não fica saudável (ex.: uma build com `HEARTBEAT_EVERY_MS=600000`) → o script tem que voltar à tag anterior sozinho, com os workers saudáveis.
3. **Caos**: `docker kill -s KILL cortex-worker-<par>` → o restart restaura do snapshot (logs: `engine restored`), e o digest bate com o `verify-run`. Reinicie o VPS (`sudo reboot`) → tudo volta sozinho (`restart: unless-stopped`). Corte a rede de um container (`docker network disconnect`) → o dead-man acusa em ≤ 5 min.
4. **24 h sem intervenção**: o healthchecks.io sem nenhum alerta por 24 h, com os N pares gravando.

## 6b. Avaliação oficial de GO/NO-GO (E7/E10)

```bash
docker run --rm -v /srv/cortex/data:/data:ro -v /srv/cortex/repo/infra/prod:/proto:ro ghcr.io/andr3wgustavo/cortex-worker:<tag> \
  node dist/evaluate.js /proto/protocol.json --data /data/market --as-of "$(date -u +%FT%TZ)" > evaluation.json
```

O avaliador refaz o replay de cada par com o código da imagem (determinístico: mesmas entradas ⇒ mesmas decisões do shadow) e aplica o protocolo. O resultado só é **oficial** (exit 0, `"official": true`) se o fingerprint do código da imagem for o registrado. Caso contrário, exit 3. Leva até ~1,5 h por par em 21 dias (cerca de 13 mil registros/s). O aviso `gzip trailer missing` no arquivo da hora atual é esperado: o worker ainda está gravando nele.

## 7. Incidentes

- **Alerta do dead-man**: `docker logs --tail 20 cortex-deadman` diz qual par e por quê (heartbeat velho, feed parado, `halted`). `halted` = a estratégia parou por risco ou divergência de ledger: **investigar antes** de `reset_halt`.
- **Disco**: medido no SOLUSDT (2026-11-11), as gravações ocupam ~1 MB/h por par, ou ~25 MB/dia (8 pares ≈ 200 MB/dia; o boot volume de 47 GB dura meses). `df -h /srv`; as gravações antigas já estão no backup off-site e podem ser arquivadas.
- **Relógio**: `chronyc tracking` (offset < 50 ms). A regra de clock skew pausa a estratégia se a diferença para a MEXC passar do limite.
