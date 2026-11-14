import type { BotEventKind, BotView, SeriesPoint, StoredEvent } from '@cortex/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api } from './lib/api';
import { LiveStore, wsUrl } from './lib/live';

/** The one live store of the app (one WebSocket for every page). */
export const live = new LiveStore({ url: () => wsUrl() });

export function useLiveVersion(): number {
  return useSyncExternalStore(live.subscribe, live.getVersion);
}

export function useViews(): BotView[] {
  const v = useLiveVersion();
  return useMemo(() => [...live.views.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)), [v]);
}

export function useView(botId: string): BotView | undefined {
  useLiveVersion();
  return live.views.get(botId);
}

/** Server-aligned clock that re-renders every `ms` (ages, staleness). */
export function useServerNow(ms = 1_000): number {
  const [t, setT] = useState(() => live.serverNow());
  useEffect(() => {
    const id = setInterval(() => setT(live.serverNow()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

/** Re-renders when the page becomes visible again (mobile tabs sleep). */
export function useVisible(): boolean {
  return useSyncExternalStore(
    (fn) => {
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
    () => document.visibilityState === 'visible',
  );
}

const EMPTY_POINTS: SeriesPoint[] = [];
export const SERIES_WINDOW_MS = 6 * 3_600_000;

/**
 * Chart history: fetched over REST once per connection epoch (so a reconnect fills the gap),
 * then kept current by the live feed.
 */
export function useSeries(botId: string): { points: SeriesPoint[]; loading: boolean } {
  const v = useLiveVersion();
  const q = useQuery({
    queryKey: ['series', botId, live.epoch],
    queryFn: async () => {
      const r = await api.series(botId, Date.now() - SERIES_WINDOW_MS);
      live.seedPoints(botId, r.points);
      return r.points.length;
    },
    enabled: live.epoch > 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const points = useMemo(() => live.points.get(botId) ?? EMPTY_POINTS, [botId, v]);
  return { points, loading: q.isPending && points.length === 0 };
}

/** Recent events of some bots (newest first), REST-seeded per epoch, then live. */
export function useEvents(botIds: string[], kinds?: BotEventKind[], limit = 200): { events: StoredEvent[]; loading: boolean } {
  const v = useLiveVersion();
  const key = botIds.join(',');
  const kindKey = kinds?.join(',') ?? '';
  const q = useQuery({
    queryKey: ['events', key, kindKey, live.epoch],
    queryFn: async () => {
      const pages = await Promise.all(botIds.map((b) => api.events(b, { limit, kinds })));
      live.seedEvents(pages.flatMap((p) => p.events));
      return true;
    },
    enabled: live.epoch > 0 && botIds.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const events = useMemo(() => {
    const ids = new Set(botIds);
    const ks = kinds ? new Set<string>(kinds) : undefined;
    return live.eventsOf(ks).filter((e) => ids.has(e.botId) && (!ks || ks.has(e.e.k)));
  }, [key, kindKey, v]);
  return { events, loading: q.isPending && botIds.length > 0 && live.epoch > 0 };
}

/** Fills of some bots (newest first) from the fills stream, REST-seeded per epoch, then live. */
export function useFills(botIds: string[], limit = 500): { fills: StoredEvent[]; loading: boolean } {
  const v = useLiveVersion();
  const key = botIds.join(',');
  const q = useQuery({
    queryKey: ['fills', key, live.epoch],
    queryFn: async () => {
      const pages = await Promise.all(botIds.map((b) => api.fills(b, { limit })));
      live.seedEvents(pages.flatMap((p) => p.events));
      return true;
    },
    enabled: live.epoch > 0 && botIds.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const fills = useMemo(() => {
    const ids = new Set(botIds);
    return live.fills.filter((e) => ids.has(e.botId));
  }, [key, v]);
  return { fills, loading: q.isPending && botIds.length > 0 && live.epoch > 0 };
}
