import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Content fingerprint of the code whose behaviour a pre-registered experiment judges: the
 * deterministic core and the shadow engine. Replaying the same recordings with code of the same
 * fingerprint reproduces every decision, so the protocol pins this, not a commit or an image tag.
 * MUST stay identical to scripts/source-fingerprint.mjs (used at bundle time; a test checks it).
 */
export const PINNED_PATHS = ['packages/core/src', 'apps/worker/src/engine'] as const;

export function sourceFingerprint(root: string, paths: readonly string[] = PINNED_PATHS): string {
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && !/\.test\.[cm]?[jt]s$/.test(e.name)) files.push(r);
    }
  };
  for (const p of [...paths].sort()) walk(p);
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f).update('\0').update(fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n')).update('\0');
  }
  return h.digest('hex');
}

declare const __CORTEX_SOURCE_FINGERPRINT__: string | undefined;

/**
 * Fingerprint of the code running now: injected at bundle time in the production image, computed
 * from the source tree when running from a checkout (tsx). Undefined if neither is available.
 */
export function runtimeFingerprint(repoRoot = process.cwd()): string | undefined {
  if (typeof __CORTEX_SOURCE_FINGERPRINT__ === 'string') return __CORTEX_SOURCE_FINGERPRINT__;
  try {
    return sourceFingerprint(repoRoot);
  } catch {
    return undefined;
  }
}
