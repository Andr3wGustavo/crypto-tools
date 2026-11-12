import type { AuditEntry } from '@cortex/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, Card, Empty, KV, Pill, Skeleton } from '../components/ui';
import { api, type Me } from '../lib/api';
import { fmtDateTime, shortAddr } from '../lib/format';

const ACTION: Record<string, string> = {
  'auth.login': 'login', 'auth.logout': 'logout', 'auth.rejected': 'login recusado',
  'command.requested': 'comando enviado', 'command.rejected': 'comando recusado', 'command.failed': 'comando falhou', 'ws.rejected': 'feed recusado',
};

function actor(a: string) {
  return a.startsWith('service:') || a === 'unknown' ? a : shortAddr(a, 5, 5);
}

export function Settings({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const audit = useInfiniteQuery({
    queryKey: ['audit'],
    queryFn: ({ pageParam }) => api.audit({ limit: 50, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const entries: AuditEntry[] = audit.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Ajustes</h1>
        <p className="text-sm text-muted">Somente leitura: configuração e segredos ficam no servidor, nunca no navegador.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Sessão">
          <KV k="Carteira" v={shortAddr(me.actor, 6, 6)} />
          <KV k="Permissões" v={me.scopes.join(', ')} />
          <div className="mt-3"><Button variant="danger" onClick={onLogout}>Sair</Button></div>
        </Card>
        <Card title="Modo">
          <KV k="Modo de trading" v={<Pill tone="brand">SHADOW</Pill>} />
          <KV k="Live" v="bloqueado até a E8" tone="warn" />
          <KV k="Chaves da corretora" v="nenhuma em uso" hint="Em shadow nenhuma chave é carregada" />
        </Card>
        <Card title="Segurança">
          <KV k="Login" v="Sign-In With Solana" />
          <KV k="Carteiras autorizadas" v="allowlist no servidor" />
          <KV k="2FA (TOTP)" v="retomar e resetar" />
          <KV k="Cookie" v="httpOnly · Secure · Strict" />
        </Card>
      </div>
      <Card title="Log de auditoria" pad={false}>
        {audit.isPending ? <Skeleton className="m-4 h-48" /> : entries.length === 0 ? <Empty title="Sem registros" /> : (
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[640px] text-sm">
              <thead><tr className="label text-left"><th className="px-4 py-3">Quando</th><th className="py-3">Quem</th><th className="py-3">Ação</th><th className="py-3">Alvo</th><th className="px-4 py-3">Detalhe</th></tr></thead>
              <tbody>{entries.map((e, i) => (
                <tr key={`${e.ts}-${i}`} className="border-t border-line/60">
                  <td className="px-4 py-2 text-muted">{fmtDateTime(e.ts)}</td>
                  <td className="py-2">{actor(e.actor)}</td>
                  <td className="py-2 font-sans">{ACTION[e.action] ?? e.action}</td>
                  <td className="py-2 text-xs text-muted">{e.target ?? '—'}</td>
                  <td className="px-4 py-2 text-xs text-faint">{e.data ? JSON.stringify(e.data) : ''}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {audit.hasNextPage && <div className="flex justify-center p-3"><Button onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>Mais antigos</Button></div>}
      </Card>
    </div>
  );
}
