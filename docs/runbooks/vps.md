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

## 3. Escolher os pares (pré-registro)

No VPS (ou no PC), **antes** de iniciar a janela de shadow:

```bash
docker run --rm -v /srv/cortex/data:/data ghcr.io/andr3wgustavo/cortex-worker:<tag> \
  node dist/scan.js --minutes 60 --every 5000 --top 8 --out /data/scans
npx tsx apps/worker/src/ops/pairs-cli.ts <scan.json>      # no PC, no repo
git add infra/prod/pairs.json infra/prod/compose.pairs.yaml && git commit && git push
```

O commit é o pré-registro: a seleção e o `paramsHash` do scanner ficam datados **antes** dos dados que vão julgá-los. Os pares não são trocados durante a janela (trocar = nova janela).

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

## 7. Incidentes

- **Alerta do dead-man**: `docker logs --tail 20 cortex-deadman` diz qual par e por quê (heartbeat velho, feed parado, `halted`). `halted` = a estratégia parou por risco ou divergência de ledger: **investigar antes** de `reset_halt`.
- **Disco**: medido no SOLUSDT (2026-11-11), as gravações ocupam ~1 MB/h por par, ou ~25 MB/dia (8 pares ≈ 200 MB/dia; o boot volume de 47 GB dura meses). `df -h /srv`; as gravações antigas já estão no backup off-site e podem ser arquivadas.
- **Relógio**: `chronyc tracking` (offset < 50 ms). A regra de clock skew pausa a estratégia se a diferença para a MEXC passar do limite.
