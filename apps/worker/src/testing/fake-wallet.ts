import { MexcRestError, type MexcCoinConfig, type MexcWithdrawAddress, type MexcWithdrawRow } from '@cortex/exchange';
import type { WalletApi } from '../withdraw/withdrawer';

export const ADDR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
export const NET = 'Solana(SOL)';

/** A fake MEXC wallet: coin config, address book, history; withdraw() appends to the history. */
export class FakeWallet implements WalletApi {
  history: MexcWithdrawRow[] = [];
  book: MexcWithdrawAddress[] = [{ coin: 'USDT', network: NET, address: ADDR }];
  config: MexcCoinConfig[] = [{ coin: 'USDT', networkList: [{ coin: 'USDT', netWork: NET, withdrawEnable: true, withdrawFee: '1', withdrawMin: '5', withdrawMax: '10000' }] }];
  calls = 0;
  /** What the next withdraw call does. */
  next: 'ok' | 'refuse' | 'timeout' | 'timeout-but-done' | 'duplicate' = 'ok';
  seq = 100;
  constructor(private readonly now: () => number) {}

  async coinConfig() {
    return this.config;
  }
  async withdrawAddresses() {
    return this.book;
  }
  async withdrawHistory(_coin: string, start?: number, end?: number) {
    return this.history.filter((r) => (start === undefined || r.applyTime >= start) && (end === undefined || r.applyTime <= end));
  }
  async withdraw(p: { coin: string; netWork: string; address: string; amount: string; withdrawOrderId: string }) {
    this.calls++;
    const mode = this.next;
    if (mode === 'refuse') throw new MexcRestError('MEXC POST /api/v3/capital/withdraw → 400: insufficient balance', 400, 10101);
    if (mode === 'duplicate') throw new MexcRestError('MEXC POST → 400: duplicate', 400, 10222);
    const row: MexcWithdrawRow = { id: String(++this.seq), withdrawOrderId: null, remark: mode === 'timeout-but-done' ? null : p.withdrawOrderId, address: p.address, amount: p.amount, applyTime: this.now(), coin: p.coin, network: p.netWork, status: 1, transactionFee: this.config[0]?.networkList?.[0]?.withdrawFee ?? '1' };
    this.history.push(row);
    if (mode.startsWith('timeout')) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return { id: row.id };
  }
  set(id: string, status: number, txId?: string) {
    const r = this.history.find((x) => x.id === id)!;
    r.status = status;
    if (txId) r.txId = txId;
  }
}
