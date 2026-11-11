/**
 * Exact, JSON-safe capture/restore of in-memory state (boot restore = snapshot + tail replay).
 *
 * JSON alone is lossy for our state: ±Infinity and NaN become null, -0 becomes 0, Map/Set become {},
 * and `undefined` fields disappear (so a restored object would silently keep its constructor value).
 * Every one of those would break bit-exact replay, so they are tagged explicitly. Doubles round-trip
 * exactly through JSON (shortest round-trip representation).
 *
 * Class instances are restored *into* an instance built by the same constructor (same config), so
 * prototypes and methods are preserved. A class instance is only allowed as a direct field of
 * another instance — inside an array/Map/Set/plain object there is no target to restore into, so
 * capture refuses it (fail loudly instead of restoring something subtly different).
 */
export class StateCodecError extends Error {
  override name = 'StateCodecError';
}

type Encoded = null | boolean | number | string | Encoded[] | { [k: string]: Encoded };

const isPlain = (v: object): boolean => {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

function encode(v: unknown, where: string, allowInstance: boolean): Encoded {
  if (v === null) return null;
  switch (typeof v) {
    case 'undefined':
      return { $u: 1 };
    case 'boolean':
    case 'string':
      return v;
    case 'number':
      if (Object.is(v, -0)) return { $n: '-0' };
      if (Number.isFinite(v)) return v;
      return { $n: Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity' };
    case 'object':
      break;
    default:
      throw new StateCodecError(`${where}: unsupported ${typeof v}`);
  }
  const o = v as object;
  if (Array.isArray(o)) return o.map((x, i) => encode(x, `${where}[${i}]`, false));
  if (o instanceof Map) return { $map: [...o.entries()].map(([k, x]) => [encode(k, `${where}.key`, false), encode(x, `${where}.get(${String(k)})`, false)]) };
  if (o instanceof Set) return { $set: [...o.values()].map((x) => encode(x, `${where}.has`, false)) };
  if (isPlain(o)) {
    const out: { [k: string]: Encoded } = {};
    for (const [k, x] of Object.entries(o)) {
      if (k.startsWith('$')) throw new StateCodecError(`${where}.${k}: keys starting with '$' are reserved`);
      out[k] = encode(x, `${where}.${k}`, false);
    }
    return out;
  }
  if (!allowInstance) throw new StateCodecError(`${where}: class instance (${o.constructor?.name}) outside an instance field`);
  return { $inst: o.constructor.name, f: captureFields(o, where, new Set()) };
}

function captureFields(o: object, where: string, skip: ReadonlySet<string>): { [k: string]: Encoded } {
  const out: { [k: string]: Encoded } = {};
  for (const [k, x] of Object.entries(o)) {
    if (skip.has(k)) continue;
    if (typeof x === 'function') throw new StateCodecError(`${where}.${k}: function-valued field`);
    out[k] = encode(x, `${where}.${k}`, true);
  }
  return out;
}

function decode(e: Encoded, where: string): unknown {
  if (e === null || typeof e !== 'object') return e;
  if (Array.isArray(e)) return e.map((x, i) => decode(x, `${where}[${i}]`));
  if ('$u' in e) return undefined;
  if ('$n' in e) {
    const n = e.$n;
    if (n === '-0') return -0;
    if (n === 'NaN') return Number.NaN;
    if (n === 'Infinity') return Number.POSITIVE_INFINITY;
    if (n === '-Infinity') return Number.NEGATIVE_INFINITY;
    throw new StateCodecError(`${where}: bad number tag ${String(n)}`);
  }
  if ('$map' in e) return new Map((e.$map as Encoded[][]).map(([k, x]) => [decode(k!, `${where}.key`), decode(x!, where)]));
  if ('$set' in e) return new Set((e.$set as Encoded[]).map((x) => decode(x, where)));
  if ('$inst' in e) throw new StateCodecError(`${where}: instance of ${String(e.$inst)} has no target to restore into`);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(e)) out[k] = decode(x, `${where}.${k}`);
  return out;
}

/** Captures every own field of `obj` (recursing into owned class instances), minus `skip`. */
export function captureState(obj: object, skip: readonly string[] = []): Record<string, Encoded> {
  return captureFields(obj, obj.constructor.name, new Set(skip));
}

/**
 * Restores a capture into `target` (built with the same constructor arguments). Fields present on
 * the target but absent from the capture are an error: the capture came from a different shape.
 */
export function restoreState(target: object, state: Record<string, Encoded>, skip: readonly string[] = []): void {
  restoreInto(target, state, target.constructor.name, new Set(skip));
}

function restoreInto(target: object, state: Record<string, Encoded>, where: string, skip: ReadonlySet<string>): void {
  const t = target as Record<string, unknown>;
  for (const k of Object.keys(t)) {
    if (!skip.has(k) && !(k in state)) throw new StateCodecError(`${where}.${k}: missing from snapshot (shape changed)`);
  }
  for (const [k, e] of Object.entries(state)) {
    if (skip.has(k)) continue;
    if (!(k in t)) throw new StateCodecError(`${where}.${k}: unknown field (shape changed)`);
    if (e !== null && typeof e === 'object' && !Array.isArray(e) && '$inst' in e) {
      const cur = t[k];
      if (cur === null || typeof cur !== 'object' || cur.constructor.name !== e.$inst) {
        throw new StateCodecError(`${where}.${k}: expected an instance of ${String(e.$inst)} on the target`);
      }
      restoreInto(cur, e.f as Record<string, Encoded>, `${where}.${k}`, new Set());
    } else {
      t[k] = decode(e, `${where}.${k}`);
    }
  }
}

/** JSON with sorted object keys: a stable byte representation for hashing configs and states. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (x && typeof x === 'object' && !Array.isArray(x) && isPlain(x)) {
      return Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]));
    }
    return x;
  });
}
