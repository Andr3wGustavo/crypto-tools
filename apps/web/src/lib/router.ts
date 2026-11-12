import { useSyncExternalStore } from 'react';

/**
 * A minimal History-API router: the dashboard has eight flat pages and one parameter, which
 * does not justify a routing library. The API serves index.html for any of these paths.
 */
export type Route =
  | { page: 'overview' }
  | { page: 'bot'; botId: string }
  | { page: 'risk' }
  | { page: 'fills' }
  | { page: 'logs' }
  | { page: 'treasury' }
  | { page: 'system' }
  | { page: 'settings' }
  | { page: 'notfound' };

export function parseRoute(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return { page: 'overview' };
  const bot = /^\/bot\/([^/]+)$/.exec(p);
  if (bot) {
    try {
      return { page: 'bot', botId: decodeURIComponent(bot[1]!) };
    } catch {
      return { page: 'notfound' };
    }
  }
  const simple = ['risk', 'fills', 'logs', 'treasury', 'system', 'settings'] as const;
  const s = simple.find((x) => p === `/${x}`);
  return s ? { page: s } : { page: 'notfound' };
}

export function hrefOf(r: Route): string {
  switch (r.page) {
    case 'overview':
      return '/';
    case 'bot':
      return `/bot/${encodeURIComponent(r.botId)}`;
    case 'notfound':
      return '/';
    default:
      return `/${r.page}`;
  }
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') window.addEventListener('popstate', notify);

export function navigate(href: string): void {
  if (href === window.location.pathname + window.location.search) return;
  window.history.pushState(null, '', href);
  window.scrollTo({ top: 0 });
  notify();
}

export function useRoute(): Route {
  const path = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => window.location.pathname,
  );
  return parseRoute(path);
}

/** Left-click without modifiers → client navigation; anything else keeps browser behaviour. */
export function onLinkClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void }, href: string): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(href);
}
