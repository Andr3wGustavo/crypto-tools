/**
 * MEXC private push channels (user data stream) → exchange-agnostic execution events.
 * Amounts stay decimal strings: the ledger is exact, so nothing here goes through a float.
 *
 * Code tables, per MEXC Spot v3 WebSocket user data streams docs:
 *   orders.status    1 NEW · 2 FILLED · 3 PARTIALLY_FILLED · 4 CANCELED · 5 PARTIALLY_CANCELED
 *   orders.tradeType 1 BUY (bid) · 2 SELL (ask)
 *   deals.tradeType  1 BUY · 2 SELL
 * An unknown code maps to UNKNOWN: the caller treats it as "state unknown" (fail-closed:
 * stop quoting that side and query the order), never as a guess.
 */
export interface MexcPrivateOrder {
  id?: string;
  clientId?: string;
  price?: string;
  quantity?: string;
  avgPrice?: string;
  orderType?: number;
  tradeType?: number;
  isMaker?: boolean;
  remainQuantity?: string;
  cumulativeQuantity?: string;
  status?: number;
  createTime?: number;
}

export interface MexcPrivateDeal {
  price?: string;
  quantity?: string;
  amount?: string;
  tradeType?: number;
  isMaker?: boolean;
  isSelfTrade?: boolean;
  tradeId?: string;
  clientOrderId?: string;
  orderId?: string;
  feeAmount?: string;
  feeCurrency?: string;
  time?: number;
}

export interface MexcPrivateAccount {
  vcoinName?: string;
  balanceAmount?: string;
  frozenAmount?: string;
  type?: string;
  time?: number;
}

export interface MexcPrivatePush {
  channel: string;
  symbol?: string;
  sendTime?: number;
  privateOrders?: MexcPrivateOrder;
  privateDeals?: MexcPrivateDeal;
  privateAccount?: MexcPrivateAccount;
}

export type ExecOrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'PARTIALLY_CANCELED' | 'UNKNOWN';

export type ExecEvent =
  | { kind: 'order'; ts: number; symbol: string; clientOrderId: string; orderId: string; side: 'BUY' | 'SELL' | null; status: ExecOrderStatus; statusCode: number | null; price: string; qty: string; cumQty: string; remainQty: string }
  | { kind: 'fill'; ts: number; symbol: string; clientOrderId: string; orderId: string; tradeId: string; side: 'BUY' | 'SELL'; price: string; qty: string; fee: string; feeAsset: string; isMaker: boolean; selfTrade: boolean }
  | { kind: 'balance'; ts: number; asset: string; free: string; locked: string };

export const mexcPrivateChannels = {
  orders: 'spot@private.orders.v3.api.pb',
  deals: 'spot@private.deals.v3.api.pb',
  account: 'spot@private.account.v3.api.pb',
} as const;

const ORDER_STATUS: Record<number, ExecOrderStatus> = { 1: 'NEW', 2: 'FILLED', 3: 'PARTIALLY_FILLED', 4: 'CANCELED', 5: 'PARTIALLY_CANCELED' };
const side = (t: number | undefined): 'BUY' | 'SELL' | null => (t === 1 ? 'BUY' : t === 2 ? 'SELL' : null);
const DEC = /^-?\d+(\.\d+)?$/;
const dec = (s: string | undefined, what: string): string => {
  if (s === undefined || s === '') return '0';
  if (!DEC.test(s)) throw new Error(`MEXC private push: ${what} is not a decimal (${s.slice(0, 20)})`);
  return s;
};

/**
 * One private push → execution events. `recvTs` (local receive time) is the event time: strategy
 * time is always local time, so replay equals live. A malformed message throws: the caller
 * records the error and fails closed (it must never be silently dropped).
 */
export function mexcPrivateToExec(p: MexcPrivatePush, recvTs: number): ExecEvent[] {
  const symbol = (p.symbol ?? '').toUpperCase();
  if (p.privateOrders) {
    const o = p.privateOrders;
    if (!o.clientId && !o.id) throw new Error('MEXC private order push without ids');
    const code = typeof o.status === 'number' ? o.status : null;
    return [{
      kind: 'order', ts: recvTs, symbol, clientOrderId: o.clientId ?? '', orderId: o.id ?? '', side: side(o.tradeType),
      status: code !== null ? ORDER_STATUS[code] ?? 'UNKNOWN' : 'UNKNOWN', statusCode: code,
      price: dec(o.price, 'price'), qty: dec(o.quantity, 'quantity'), cumQty: dec(o.cumulativeQuantity, 'cumulativeQuantity'), remainQty: dec(o.remainQuantity, 'remainQuantity'),
    }];
  }
  if (p.privateDeals) {
    const d = p.privateDeals;
    const s = side(d.tradeType);
    if (!d.tradeId || !s) throw new Error('MEXC private deal push without tradeId or side');
    return [{
      kind: 'fill', ts: recvTs, symbol, clientOrderId: d.clientOrderId ?? '', orderId: d.orderId ?? '', tradeId: d.tradeId, side: s,
      price: dec(d.price, 'price'), qty: dec(d.quantity, 'quantity'), fee: dec(d.feeAmount, 'feeAmount'), feeAsset: (d.feeCurrency ?? '').toUpperCase(),
      isMaker: d.isMaker === true, selfTrade: d.isSelfTrade === true,
    }];
  }
  if (p.privateAccount) {
    const a = p.privateAccount;
    if (!a.vcoinName) throw new Error('MEXC private account push without asset');
    return [{ kind: 'balance', ts: recvTs, asset: a.vcoinName.toUpperCase(), free: dec(a.balanceAmount, 'balanceAmount'), locked: dec(a.frozenAmount, 'frozenAmount') }];
  }
  return [];
}
