import type { AuditEntry, BotEventKind, BotView, EngineCommandName, SeriesPoint, StoredEvent, SystemInfo } from '@cortex/shared';

/**
 * Typed client of the operator API. Same origin: the session cookie (httpOnly, SameSite=Strict)
 * travels by itself, and the browser adds the Origin header the API checks on writes.
 * The request/response types are the @cortex/shared contracts the API serves.
 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface Me {
  kind: 'wallet' | 'service';
  actor: string;
  scopes: string[];
}

type Fetch = typeof fetch;
const unauthorizedListeners = new Set<() => void>();
/** Fired on any 401: the session expired or was revoked. */
export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export function createApi(f: Fetch = (...a) => fetch(...a)) {
  async function req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await f(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = res.statusText || `HTTP ${res.status}`;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        /* non-JSON error body */
      }
      if (res.status === 401) unauthorizedListeners.forEach((l) => l());
      throw new ApiError(res.status, msg);
    }
    return (await res.json()) as T;
  }
  const qs = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const bot = (id: string) => `/bots/${encodeURIComponent(id)}`;
  type Page = { events: StoredEvent[]; next: string | null };

  return {
    me: () => req<Me>('GET', '/auth/me'),
    nonce: (address: string) => req<{ message: string }>('POST', '/auth/nonce', { address }),
    verify: (message: string, signature: string) => req<{ address: string; expiresAt: string }>('POST', '/auth/verify', { message, signature }),
    logout: () => req<{ ok: true }>('POST', '/auth/logout', {}),
    bots: () => req<{ bots: BotView[]; missing: string[] }>('GET', '/bots'),
    events: (id: string, o: { limit?: number; before?: string; kinds?: BotEventKind[] } = {}) =>
      req<Page>('GET', `${bot(id)}/events${qs({ limit: o.limit, before: o.before, kinds: o.kinds?.join(',') })}`),
    fills: (id: string, o: { limit?: number; before?: string } = {}) => req<Page>('GET', `${bot(id)}/fills${qs(o)}`),
    series: (id: string, since?: number) => req<{ points: SeriesPoint[] }>('GET', `${bot(id)}/series${qs({ since })}`),
    audit: (o: { limit?: number; before?: number } = {}) => req<{ entries: AuditEntry[]; next: number | null }>('GET', `/audit${qs(o)}`),
    system: () => req<SystemInfo>('GET', '/system/info'),
    command: (id: string, command: EngineCommandName, totp?: string) =>
      req<{ id: string; streamId: string }>('POST', `${bot(id)}/commands`, totp ? { command, totp } : { command }),
  };
}

export type Api = ReturnType<typeof createApi>;
export const api = createApi();
