// Content fingerprint of the code whose behaviour a pre-registered experiment judges.
// MUST stay identical to apps/worker/src/ops/source-fingerprint.ts (a test checks they agree).
// sha256 over (posix relative path, NUL, content with CRLF → LF, NUL) of every non-test file,
// so it is the same on a Windows checkout (autocrlf) and inside the Linux image build.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PINNED_PATHS = ['packages/core/src', 'apps/worker/src/engine'];

export function sourceFingerprint(root, paths = PINNED_PATHS) {
  const files = [];
  const walk = (rel) => {
    const full = path.join(root, rel);
    for (const e of fs.readdirSync(full, { withFileTypes: true })) {
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
