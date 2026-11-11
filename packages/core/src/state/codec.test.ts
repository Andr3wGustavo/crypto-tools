import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { StateCodecError, canonicalJson, captureState, restoreState } from './codec';

class Inner {
  hist: Array<{ ts: number; v: number }> = [];
  done = new Set<number>();
  constructor(readonly halfLife: number) {}
}

class Outer {
  last = Number.NEGATIVE_INFINITY;
  queue = Number.POSITIVE_INFINITY;
  z = 0;
  nan = 0;
  maybe: number | undefined = 7;
  orders = new Map<string, { px: number; cancelAt?: number | undefined }>();
  readonly inner = new Inner(5);
  constructor(readonly cfg: { a: number }) {}
  sum(): number {
    return this.inner.hist.reduce((s, h) => s + h.v, 0);
  }
}

const roundTrip = <T extends object>(src: T, fresh: T): T => {
  restoreState(fresh, JSON.parse(JSON.stringify(captureState(src))));
  return fresh;
};

describe('state codec', () => {
  it('round-trips the values plain JSON loses: ±Infinity, NaN, -0, undefined, Map, Set', () => {
    const a = new Outer({ a: 1 });
    a.last = 1_700_000_000_123;
    a.z = -0;
    a.nan = Number.NaN;
    a.maybe = undefined; // a fresh instance has 7: a dropped key would silently keep it
    a.orders.set('cf1', { px: 88.12, cancelAt: undefined });
    a.inner.hist.push({ ts: 1, v: 0.1 + 0.2 });
    a.inner.done.add(1000).add(5000);
    const b = roundTrip(a, new Outer({ a: 1 }));
    expect(b.last).toBe(1_700_000_000_123);
    expect(b.queue).toBe(Number.POSITIVE_INFINITY);
    expect(Object.is(b.z, -0)).toBe(true);
    expect(b.nan).toBeNaN();
    expect(b.maybe).toBeUndefined();
    expect('cancelAt' in b.orders.get('cf1')!).toBe(true);
    expect(b.inner).toBeInstanceOf(Inner);
    expect(b.sum()).toBe(0.1 + 0.2); // methods survive; doubles are bit-exact
    expect([...b.inner.done]).toEqual([1000, 5000]);
  });

  it('property: any double survives bit-exactly', () => {
    fc.assert(
      fc.property(fc.double(), (x) => {
        const a = new Outer({ a: 1 });
        a.last = x;
        expect(Object.is(roundTrip(a, new Outer({ a: 1 })).last, x)).toBe(true);
      }),
    );
  });

  it('refuses shapes it cannot restore faithfully', () => {
    const withFn = new Outer({ a: 1 }) as Outer & { cb?: () => void };
    withFn.cb = () => undefined;
    expect(() => captureState(withFn)).toThrow(StateCodecError);
    const nested = new Outer({ a: 1 });
    (nested.orders as Map<string, unknown>).set('x', new Inner(1));
    expect(() => captureState(nested)).toThrow(/outside an instance field/);
    const snap = captureState(new Outer({ a: 1 }));
    delete snap.queue;
    expect(() => restoreState(new Outer({ a: 1 }), snap)).toThrow(/missing from snapshot/);
    expect(() => restoreState(new Outer({ a: 1 }), { ...captureState(new Outer({ a: 1 })), extra: 1 })).toThrow(/unknown field/);
  });

  it('skip leaves fields untouched', () => {
    const a = new Outer({ a: 2 });
    const b = new Outer({ a: 1 });
    restoreState(b, captureState(a, ['cfg']), ['cfg']);
    expect(b.cfg.a).toBe(1);
    restoreState(b, captureState(a), ['cfg']); // skipped even when present in the capture
    expect(b.cfg.a).toBe(1);
  });

  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: [1, { x: 2, y: 1 }] }, b: 1 }));
  });
});
