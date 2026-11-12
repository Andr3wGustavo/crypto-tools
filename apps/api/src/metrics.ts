import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics of the API (one registry per app instance, so tests stay isolated). */
export function createMetrics(defaults = true) {
  const registry = new Registry();
  if (defaults) collectDefaultMetrics({ register: registry, prefix: 'cortex_api_' });
  const http = new Histogram({
    name: 'cortex_api_http_request_duration_seconds',
    help: 'HTTP request duration by route template and status class',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  const authRejected = new Counter({ name: 'cortex_api_auth_rejected_total', help: 'Rejected sign-ins by reason', labelNames: ['reason'] as const, registers: [registry] });
  const commands = new Counter({ name: 'cortex_api_commands_total', help: 'Operator commands by command and result', labelNames: ['command', 'result'] as const, registers: [registry] });
  const wsClients = new Gauge({ name: 'cortex_api_ws_clients', help: 'Connected dashboard WebSockets', registers: [registry] });
  const wsRejected = new Counter({ name: 'cortex_api_ws_rejected_total', help: 'Refused WebSocket upgrades by reason', labelNames: ['reason'] as const, registers: [registry] });
  const botViewAge = new Gauge({ name: 'cortex_api_bot_view_age_seconds', help: 'Age of each bot latest view (scrape time)', labelNames: ['bot'] as const, registers: [registry] });
  return { registry, http, authRejected, commands, wsClients, wsRejected, botViewAge };
}
export type Metrics = ReturnType<typeof createMetrics>;
