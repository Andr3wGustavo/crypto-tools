import { describe, expect, it } from 'vitest';
import { renderPairsCompose, validatePairs, type PairsFile } from './pairs-compose';

const f: PairsFile = {
  scan: { file: 'scan-x.json', paramsHash: 'a'.repeat(64), startedAt: '2026-11-12T10:00:00.000Z' },
  pairs: [{ symbol: 'DOTUSDT', reference: 'DOTUSDT' }, { symbol: 'TAOUSDT', reference: 'TAOUSDT' }],
};

describe('pairs compose', () => {
  it('one isolated worker per pair + a dead-man that expects exactly those pairs', () => {
    const y = renderPairsCompose(f);
    expect(y.match(/^ {2}worker-[a-z0-9]+:$/gm)).toEqual(['  worker-dotusdt:', '  worker-taousdt:']);
    expect(y).toContain('BOT_SYMBOL: DOTUSDT');
    expect(y).toContain('BOT_REFERENCE_SYMBOL: TAOUSDT');
    expect(y).toContain('EXPECTED_BOTS: DOTUSDT,TAOUSDT');
    expect(y).toContain('TRADING_MODE: shadow');
    expect(y).toContain('connection_limit=3'); // 10 workers × default pool would exhaust Postgres
    expect(y).not.toMatch(/\t/);
  });

  it('refuses invalid, duplicate or empty selections', () => {
    expect(() => validatePairs({ ...f, pairs: [] })).toThrow(/no pairs/);
    expect(() => validatePairs({ ...f, pairs: [f.pairs[0]!, f.pairs[0]!] })).toThrow(/duplicate/);
    expect(() => validatePairs({ ...f, pairs: [{ symbol: 'dot; rm -rf /', reference: 'DOTUSDT' }] })).toThrow(/invalid symbol/);
    expect(() => validatePairs({ ...f, scan: { ...f.scan, paramsHash: 'x' } })).toThrow(/sha256/);
  });
});
