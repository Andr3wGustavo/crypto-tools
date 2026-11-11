import path from 'node:path';
import protobuf from 'protobufjs';

/**
 * Decoder for MEXC v3 WebSocket push frames (protobuf, wrapper = PushDataV3ApiWrapper).
 * Schemas are vendored, reviewed copies of github.com/mexcdevelop/websocket-proto (Apache-2.0).
 */
export interface MexcAggreBookTicker {
  bidPrice: string;
  bidQuantity: string;
  askPrice: string;
  askQuantity: string;
}

export interface MexcAggreDeal {
  price: string;
  quantity: string;
  /** 1 = buy (taker buy), 2 = sell (taker sell) — per MEXC Trade Streams docs. */
  tradeType: number;
  time: number;
  tradeId?: string;
}

export interface MexcPush {
  channel: string;
  symbol?: string;
  sendTime?: number;
  createTime?: number;
  publicAggreBookTicker?: MexcAggreBookTicker;
  publicAggreDeals?: { deals: MexcAggreDeal[] };
}

/** Overridable for bundled builds (the Docker image ships the protos at a fixed path). */
export const MEXC_PROTO_DIR = process.env.MEXC_PROTO_DIR ?? path.resolve(__dirname, '../../proto/mexc');

let wrapperType: protobuf.Type | undefined;

export function loadMexcWrapper(protoDir = MEXC_PROTO_DIR): protobuf.Type {
  if (wrapperType) return wrapperType;
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) => path.join(protoDir, path.basename(target));
  root.loadSync('PushDataV3ApiWrapper.proto', { keepCase: true });
  wrapperType = root.lookupType('PushDataV3ApiWrapper');
  return wrapperType;
}

export function decodeMexcPush(buf: Uint8Array): MexcPush {
  const T = loadMexcWrapper();
  const msg = T.decode(buf);
  return T.toObject(msg, { longs: Number, defaults: false, oneofs: false }) as MexcPush;
}

/** For tests and replay fixtures. */
export function encodeMexcPush(obj: MexcPush): Uint8Array {
  const T = loadMexcWrapper();
  const err = T.verify(obj);
  if (err) throw new Error(`invalid MEXC push: ${err}`);
  return T.encode(T.fromObject(obj)).finish();
}

export const mexcChannels = {
  bookTicker: (symbol: string, interval: '10ms' | '100ms' = '100ms') => `spot@public.aggre.bookTicker.v3.api.pb@${interval}@${symbol.toUpperCase()}`,
  deals: (symbol: string, interval: '10ms' | '100ms' = '100ms') => `spot@public.aggre.deals.v3.api.pb@${interval}@${symbol.toUpperCase()}`,
};
