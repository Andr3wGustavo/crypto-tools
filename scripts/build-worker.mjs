// Bundles the worker (and the replay CLI) into self-contained CJS files for the production image.
// Prisma stays external: its query engine is a native per-platform binary shipped next to the bundle.
import { build } from 'esbuild';

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
};

await build({ ...common, entryPoints: ['apps/worker/src/main.ts'], outfile: 'dist/worker/main.js' });
await build({ ...common, entryPoints: ['apps/worker/src/replay.ts'], outfile: 'dist/worker/replay.js' });
