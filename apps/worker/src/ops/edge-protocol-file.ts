import crypto from 'node:crypto';
import { canonicalJson, DEFAULT_EDGE_PROTOCOL_RULE, validateEdgeProtocolRule, type EdgeProtocolRule } from '@cortex/core';
import { validatePairs, type PairsFile } from './pairs-compose';
import { PINNED_PATHS } from './source-fingerprint';

/**
 * infra/prod/protocol.json: the pre-registered experiment. Written together with pairs.json by
 * pairs-cli and committed BEFORE the shadow window opens; the commit is the timestamp nobody can
 * move. It fixes which pairs are judged (m), by which rule, from when, and which code (content
 * fingerprint of the core + engine) is being judged. The hash makes any later edit evident.
 */
export interface EdgeProtocolFile {
  kind: 'edge-protocol';
  version: 1;
  /** Only edge windows that start at or after this instant count. */
  registeredAt: string;
  /** Content fingerprint of the judged code (see source-fingerprint.ts) and where it was taken. */
  code: { fingerprint: string; paths: string[]; commit: string };
  scan: PairsFile['scan'];
  pairs: string[];
  rule: EdgeProtocolRule;
  hash: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;

export function edgeProtocolHash(f: Omit<EdgeProtocolFile, 'hash'>): string {
  return crypto.createHash('sha256').update(canonicalJson(f)).digest('hex');
}

export function makeEdgeProtocol(
  pairs: PairsFile,
  registeredAt: Date,
  code: { fingerprint: string; commit: string },
  rule: EdgeProtocolRule = DEFAULT_EDGE_PROTOCOL_RULE,
): EdgeProtocolFile {
  validatePairs(pairs);
  validateEdgeProtocolRule(rule);
  const body: Omit<EdgeProtocolFile, 'hash'> = {
    kind: 'edge-protocol',
    version: 1,
    registeredAt: registeredAt.toISOString(),
    code: { fingerprint: code.fingerprint, paths: [...PINNED_PATHS], commit: code.commit },
    scan: pairs.scan,
    pairs: pairs.pairs.map((p) => p.symbol),
    rule,
  };
  const f = { ...body, hash: edgeProtocolHash(body) };
  verifyEdgeProtocol(f);
  return f;
}

/** Parses and checks a protocol file; throws on anything malformed or edited after hashing. */
export function verifyEdgeProtocol(raw: unknown): EdgeProtocolFile {
  const f = raw as EdgeProtocolFile;
  if (!f || f.kind !== 'edge-protocol' || f.version !== 1) throw new Error('not an edge-protocol v1 file');
  const { hash, ...body } = f;
  if (!HEX64.test(hash ?? '') || edgeProtocolHash(body) !== hash) throw new Error('protocol hash mismatch: the file was edited after registration');
  if (Number.isNaN(Date.parse(f.registeredAt))) throw new Error('invalid registeredAt');
  if (!HEX64.test(f.code?.fingerprint ?? '') || !SHA.test(f.code?.commit ?? '')) throw new Error('invalid code identity');
  if (f.pairs.length === 0 || new Set(f.pairs).size !== f.pairs.length) throw new Error('pairs must be non-empty and unique');
  validateEdgeProtocolRule(f.rule);
  return f;
}
