// Bundles the worker (and the replay CLI) into self-contained CJS files for the production image.
// Prisma stays external: its query engine is a native per-platform binary shipped next to the bundle.
import { build } from 'esbuild';
import { sourceFingerprint } from './source-fingerprint.mjs';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  // Optional native accelerators of `ws`; it falls back to pure JS when they are absent.
  external: ['@prisma/client', '.prisma/client', 'bufferutil', 'utf-8-validate'],
  // Identity of the strategy code in this bundle (checked against the pre-registered protocol).
  define: { __CORTEX_SOURCE_FINGERPRINT__: JSON.stringify(sourceFingerprint(process.cwd())) },
};

await build({ ...common, entryPoints: ['apps/worker/src/main.ts'], outfile: 'dist/worker/main.js' });
await build({ ...common, entryPoints: ['apps/worker/src/replay.ts'], outfile: 'dist/worker/replay.js' });
await build({ ...common, entryPoints: ['apps/worker/src/scan.ts'], outfile: 'dist/worker/scan.js' });
await build({ ...common, entryPoints: ['apps/worker/src/deadman.ts'], outfile: 'dist/worker/deadman.js' });
await build({ ...common, entryPoints: ['apps/worker/src/alerter-main.ts'], outfile: 'dist/worker/alerter.js' });
await build({ ...common, entryPoints: ['apps/worker/src/live-main.ts'], outfile: 'dist/worker/live.js' });
await build({ ...common, entryPoints: ['apps/worker/src/verify-run.ts'], outfile: 'dist/worker/verify-run.js' });
await build({ ...common, entryPoints: ['apps/worker/src/healthcheck.ts'], outfile: 'dist/worker/healthcheck.js' });
await build({ ...common, entryPoints: ['apps/worker/src/evaluate.ts'], outfile: 'dist/worker/evaluate.js' });
// Operator API (separate image target `api`).
await build({ ...common, entryPoints: ['apps/api/src/main.ts'], outfile: 'dist/api/main.js' });
await build({ ...common, entryPoints: ['apps/api/src/provision.ts'], outfile: 'dist/api/provision.js' });
