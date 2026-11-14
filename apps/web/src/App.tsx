import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Layout } from './components/Layout';
import { Card, Empty, Link, Skeleton, ToastProvider } from './components/ui';
import { ApiError, api, onUnauthorized } from './lib/api';
import { useRoute } from './lib/router';
import { BotDetail } from './pages/BotDetail';
import { Fills } from './pages/Fills';
import { Login } from './pages/Login';
import { Logs } from './pages/Logs';
import { Overview } from './pages/Overview';
import { Risk } from './pages/Risk';
import { Settings } from './pages/Settings';
import { System } from './pages/System';
import { Treasury } from './pages/Treasury';
import { live, useLiveVersion } from './state';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 means "sign in again", never "retry".
      retry: (n, err) => !(err instanceof ApiError && (err.status === 401 || err.status === 403)) && n < 2,
      refetchOnWindowFocus: false,
    },
  },
});

function Shell() {
  const qc = useQueryClient();
  const route = useRoute();
  useLiveVersion();
  const [expired, setExpired] = useState(false);
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Number.POSITIVE_INFINITY, retry: false });

  // Signed in → open the live feed; signed out → close it and forget everything.
  const signedIn = me.isSuccess;
  useEffect(() => {
    if (signedIn) live.connect();
    return () => live.disconnect();
  }, [signedIn]);

  useEffect(() => onUnauthorized(() => {
    // Only a session that existed can expire: the first visit's /auth/me probe is a 401 too.
    if (qc.getQueryData(['me']) !== undefined) setExpired(true);
    live.reset();
    qc.setQueryData(['me'], undefined);
    void qc.invalidateQueries({ queryKey: ['me'] });
  }), [qc]);

  // The feed closed with 4401 (expired/revoked session): back to sign-in.
  useEffect(() => {
    if (live.state === 'unauthorized' && signedIn) {
      setExpired(true);
      live.reset();
      qc.removeQueries();
    }
  });

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      live.reset();
      qc.removeQueries();
      setExpired(false);
    }
  };

  if (me.isPending) return <div className="mx-auto max-w-md p-8"><Skeleton className="h-64" /></div>;
  if (!me.isSuccess) {
    const unauth = me.error instanceof ApiError && me.error.status === 401;
    if (!unauth) {
      return (
        <div className="mx-auto max-w-md p-8">
          <Card><Empty title="API indisponível" icon="⚠">{(me.error as Error)?.message ?? 'erro'}. Tentando de novo…</Empty></Card>
        </div>
      );
    }
    return <Login expired={expired} onSignedIn={() => {
      setExpired(false);
      live.reset();
      void qc.invalidateQueries();
    }} />;
  }

  const page = (() => {
    switch (route.page) {
      case 'overview': return <Overview />;
      case 'bot': return <BotDetail botId={route.botId} />;
      case 'risk': return <Risk />;
      case 'fills': return <Fills />;
      case 'logs': return <Logs />;
      case 'treasury': return <Treasury />;
      case 'system': return <System />;
      case 'settings': return <Settings me={me.data} onLogout={() => void logout()} />;
      default: return <Card><Empty title="Página não encontrada"><Link href="/" className="text-brand hover:underline">Ir para a visão geral</Link></Empty></Card>;
    }
  })();

  return <Layout route={route} me={me.data} onLogout={() => void logout()}>{page}</Layout>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </QueryClientProvider>
  );
}
