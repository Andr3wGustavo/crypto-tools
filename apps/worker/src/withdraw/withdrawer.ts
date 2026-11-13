import fs from 'node:fs';
import path from 'node:path';
import { BN } from '@cortex/core';
import {
  MEXC_WITHDRAW_STATUS, classifyMexcError, mexcWithdrawOutcome, networkName,
  type MexcCoinConfig, type MexcCoinNetwork, type MexcWithdrawAddress, type MexcWithdrawRow,
} from '@cortex/exchange';
import type { WithdrawRequestMsg } from './channel';

/** MEXC wallet endpoints the withdrawer uses (MexcRest implements them, with the withdraw key). */
export interface WalletApi {
  coinConfig(): Promise<MexcCoinConfig[]>;
  withdraw(p: { coin: string; netWork: string; address: string; amount: string; withdrawOrderId: string; memo?: string }): Promise<{ id: string }>;
  withdrawHistory(coin: string, startTime?: number, endTime?: number, limit?: number): Promise<MexcWithdrawRow[]>;
  withdrawAddresses(coin: string): Promise<MexcWithdrawAddress[]>;
}

/**
 * Write-ahead journal: what this process did about each withdrawal id. `submitting` is written
 * (and fsync'd) BEFORE the withdraw call, so after a crash we know a call may have happened and
 * never repeat it. Last entry per id wins.
 */
export type JournalState = 'submitting' | 'submitted' | 'refused' | 'aborted' | 'resolved';
export interface JournalEntry {
  id: string;
  state: JournalState;
  ts: number;
  amount?: string;
  exchangeId?: string;
  reason?: string;
  /** `resolved` only: a human's final answer. */
  status?: 'CONFIRMED' | 'FAILED';
  fee?: string;
}

export interface Journal {
  get(id: string): JournalEntry | undefined;
  append(e: JournalEntry): void;
}

export class MemoryJournal implements Journal {
  readonly entries: JournalEntry[] = [];
  private readonly last = new Map<string, JournalEntry>();
  get(id: string) {
    return this.last.get(id);
  }
  append(e: JournalEntry) {
    this.entries.push(e);
    this.last.set(e.id, e);
  }
}

/** JSON lines, fsync'd on every append. A torn last line (crash mid-write) is ignored. */
export class FileJournal implements Journal {
  private readonly last = new Map<string, JournalEntry>();
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as JournalEntry;
          if (typeof e.id === 'string' && typeof e.state === 'string') this.last.set(e.id, e);
        } catch {
          /* torn tail */
        }
      }
    }
  }
  get(id: string) {
    return this.last.get(id);
  }
  append(e: JournalEntry) {
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(e)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.last.set(e.id, e);
  }
}

export interface WithdrawerConfig {
  coin: string;
  /** Exact network name from the coin config (`netWork`), e.g. the Solana network of USDT. */
  network: string;
  /** The treasury wallet. Must be in the account's withdrawal address book. */
  address: string;
  memo?: string;
  /** Hard floor (US$20 by the plan); the exchange's own minimum + fee also applies. */
  minAmount: number;
  dailyCap: number;
  cooldownMs: number;
  /** A `submit` older than this is refused (the engine re-decides with fresh locks). */
  maxRequestAgeMs: number;
  /** A possibly-submitted withdrawal not found in the history after this long needs a human. */
  unresolvedAfterMs: number;
}

export const DEFAULT_WITHDRAWER: Pick<WithdrawerConfig, 'minAmount' | 'dailyCap' | 'cooldownMs' | 'maxRequestAgeMs' | 'unresolvedAfterMs'> = {
  minAmount: 20, dailyCap: 100, cooldownMs: 24 * 3_600_000, maxRequestAgeMs: 10 * 60_000, unresolvedAfterMs: 30 * 60_000,
};

export type WithdrawReport = { id: string; status: 'SENT' | 'CONFIRMED' | 'FAILED'; amount?: string; fee?: string; exchangeId?: string; txId?: string; reason?: string };

export class WithdrawSetupError extends Error {
  override name = 'WithdrawSetupError';
  constructor(readonly problems: string[]) {
    super(`withdrawer refused to start:\n - ${problems.join('\n - ')}`);
  }
}

const DAY = 24 * 3_600_000;
const HISTORY_MAX_MS = 7 * DAY;

/**
 * The only code that can move money off the exchange. It trusts nothing it is told:
 *
 *  1. Destination: one address, from its own configuration, that must be in the account's
 *     withdrawal address book (checked at start and before every submit).
 *  2. Amount: ≥ max(minAmount, exchange minimum, fee), ≤ exchange maximum and the daily cap.
 *  3. Frequency: at most one withdrawal per cooldown and `dailyCap` per 24 h, counted from the
 *     EXCHANGE's withdrawal history (includes anything done by hand).
 *  4. Idempotency: our id is the exchange's `withdrawOrderId`; the journal is written before the
 *     call; an id seen before is never submitted again. Status comes from the exchange history.
 *  5. Fail-closed: a refusal is final only when nothing can have been sent. An ambiguous outcome
 *     stays SENT (the reserve stays reserved) until the history or a human settles it.
 */
export class Withdrawer {
  private network: MexcCoinNetwork | undefined;

  constructor(
    readonly cfg: WithdrawerConfig,
    private readonly api: WalletApi,
    private readonly journal: Journal,
    private readonly clock: () => number = Date.now,
    private readonly log: (level: 'info' | 'warn' | 'error', o: Record<string, unknown>) => void = () => undefined,
  ) {}

  /** Start-up gate: coin, network enabled, address whitelisted, limits consistent. Throws with every problem. */
  async verifySetup(): Promise<{ network: string; fee: string; min: string; max: string }> {
    const problems = await this.checkVenue();
    if (problems.length > 0) throw new WithdrawSetupError(problems);
    const n = this.network!;
    return { network: networkName(n), fee: n.withdrawFee ?? '?', min: n.withdrawMin ?? '?', max: n.withdrawMax ?? '?' };
  }

  private async checkVenue(): Promise<string[]> {
    const problems: string[] = [];
    const coins = await this.api.coinConfig();
    const coin = coins.find((c) => c.coin?.toUpperCase() === this.cfg.coin);
    const net = coin?.networkList?.find((n) => networkName(n) === this.cfg.network);
    if (!coin) problems.push(`coin ${this.cfg.coin} not found in the MEXC coin config`);
    else if (!net) problems.push(`network "${this.cfg.network}" not found for ${this.cfg.coin} (available: ${(coin.networkList ?? []).map(networkName).join(', ')})`);
    else if (net.withdrawEnable === false) problems.push(`withdrawals of ${this.cfg.coin} on ${this.cfg.network} are disabled by MEXC right now`);
    this.network = net;
    if (net) {
      const floor = new BN(net.withdrawMin ?? 0).plus(net.withdrawFee ?? 0);
      if (floor.gt(this.cfg.dailyCap)) problems.push(`the daily cap ${this.cfg.dailyCap} is below the network minimum + fee ${floor.toFixed()}`);
    }
    const book = await this.api.withdrawAddresses(this.cfg.coin);
    const listed = book.some((a) => a.address === this.cfg.address && (a.memo ?? '') === (this.cfg.memo ?? '') && (!a.coin || a.coin.toUpperCase() === this.cfg.coin));
    if (!listed) problems.push(`the treasury address is not in the account's ${this.cfg.coin} withdrawal address book`);
    return problems;
  }

  /** One request → one report (or null: nothing to say). Callers serialize calls. */
  async handle(req: WithdrawRequestMsg): Promise<WithdrawReport | null> {
    const id = req.id;
    const j = this.journal.get(id);
    if (j?.state === 'refused' || j?.state === 'aborted') return { id, status: 'FAILED', reason: j.reason ?? j.state };
    if (j?.state === 'resolved') {
      return j.status === 'CONFIRMED'
        ? { id, status: 'CONFIRMED', amount: j.amount ?? req.amount, fee: j.fee ?? '0', reason: 'resolved by a human' }
        : { id, status: 'FAILED', reason: j.reason ?? 'resolved by a human' };
    }

    // Anything this id may already have done on the exchange decides first.
    const row = await this.findOnExchange(req, j);
    if (row) {
      if (!j || j.state === 'submitting') this.journal.append({ id, state: 'submitted', ts: this.clock(), amount: req.amount, exchangeId: row.id });
      return this.fromRow(req, row);
    }
    if (j?.state === 'submitted') return { id, status: 'SENT', exchangeId: j.exchangeId!, reason: 'accepted; not in the history yet' };
    if (j?.state === 'submitting') {
      const age = this.clock() - j.ts;
      if (age < this.cfg.unresolvedAfterMs) return { id, status: 'SENT', reason: 'outcome unknown; checking the history' };
      this.log('error', { msg: 'withdrawal outcome unresolved: a human must check MEXC and run `withdraw resolve`', id, amount: req.amount, ageMs: age });
      return { id, status: 'SENT', reason: 'unresolved: check MEXC, then `withdraw resolve`' };
    }

    // Never submitted by us, and not on the exchange.
    if (req.mode === 'abort') {
      this.journal.append({ id, state: 'aborted', ts: this.clock(), amount: req.amount, reason: 'aborted by the engine (a lock closed)' });
      return { id, status: 'FAILED', reason: 'aborted by the engine (a lock closed)' };
    }
    if (req.mode === 'status') {
      this.log('error', { msg: 'the engine believes this withdrawal was sent, but the journal and the exchange history do not know it', id, amount: req.amount });
      return { id, status: 'SENT', reason: 'unknown to the withdrawer: check MEXC, then `withdraw resolve`' };
    }
    return this.submit(req);
  }

  private refuse(req: WithdrawRequestMsg, reason: string): WithdrawReport {
    this.journal.append({ id: req.id, state: 'refused', ts: this.clock(), amount: req.amount, reason });
    this.log('warn', { msg: 'withdrawal refused (nothing sent)', id: req.id, amount: req.amount, reason });
    return { id: req.id, status: 'FAILED', reason };
  }

  private async submit(req: WithdrawRequestMsg): Promise<WithdrawReport> {
    const now = this.clock();
    if (req.asset !== this.cfg.coin) return this.refuse(req, `asset ${req.asset} is not the configured coin ${this.cfg.coin}`);
    if (now - req.createdTs > this.cfg.maxRequestAgeMs) return this.refuse(req, `stale request (${Math.round((now - req.createdTs) / 1000)} s old)`);
    const venue = await this.checkVenue();
    if (venue.length > 0) return this.refuse(req, venue.join('; '));
    const n = this.network!;
    const amount = new BN(req.amount);
    const fee = new BN(n.withdrawFee ?? 0);
    // The plan's floor: max(US$20, network minimum + fee). The fee must also leave something.
    const min = BN.max(this.cfg.minAmount, new BN(n.withdrawMin ?? 0).plus(fee));
    if (!amount.gt(fee)) return this.refuse(req, `amount ${req.amount} does not cover the fee ${fee.toFixed()}`);
    if (!amount.isFinite() || amount.lt(min)) return this.refuse(req, `amount ${req.amount} below the minimum ${min.toFixed()}`);
    if (n.withdrawMax && amount.gt(n.withdrawMax)) return this.refuse(req, `amount ${req.amount} above the exchange maximum ${n.withdrawMax}`);
    if (amount.gt(this.cfg.dailyCap)) return this.refuse(req, `amount ${req.amount} above the daily cap ${this.cfg.dailyCap}`);
    const multiple = n.withdrawIntegerMultiple ? new BN(n.withdrawIntegerMultiple) : undefined;
    if (multiple && multiple.gt(0) && !amount.mod(multiple).isZero()) return this.refuse(req, `amount ${req.amount} is not a multiple of ${multiple.toFixed()}`);

    // Frequency limits from the exchange's own history (anything not failed/canceled counts).
    const recent = (await this.api.withdrawHistory(this.cfg.coin, now - DAY, now)).filter((r) => mexcWithdrawOutcome(r.status) !== 'failed');
    const lastApply = recent.reduce((m, r) => Math.max(m, Number(r.applyTime) || 0), 0);
    if (lastApply > 0 && now - lastApply < this.cfg.cooldownMs) return this.refuse(req, `cooldown: last ${this.cfg.coin} withdrawal ${Math.round((now - lastApply) / 60_000)} min ago`);
    const sum = recent.reduce((a, r) => a.plus(r.amount), new BN(0));
    if (sum.plus(amount).gt(this.cfg.dailyCap)) return this.refuse(req, `daily cap: ${sum.toFixed()} already withdrawn in 24 h`);

    this.journal.append({ id: req.id, state: 'submitting', ts: now, amount: req.amount });
    try {
      const r = await this.api.withdraw({
        coin: this.cfg.coin, netWork: this.cfg.network, address: this.cfg.address, amount: amount.toFixed(), withdrawOrderId: req.id,
        ...(this.cfg.memo ? { memo: this.cfg.memo } : {}),
      });
      this.journal.append({ id: req.id, state: 'submitted', ts: this.clock(), amount: req.amount, exchangeId: r.id });
      this.log('warn', { msg: 'withdrawal submitted', id: req.id, amount: req.amount, exchangeId: r.id });
      return { id: req.id, status: 'SENT', exchangeId: r.id };
    } catch (err) {
      const kind = classifyMexcError(err);
      if (kind === 'unknown') {
        this.log('error', { msg: 'withdraw call outcome unknown: stays SENT until the history says', id: req.id, err: String(err) });
        return { id: req.id, status: 'SENT', reason: `outcome unknown: ${String(err).slice(0, 120)}` };
      }
      // Refused by the exchange — unless it was refused because it already exists.
      const row = await this.findOnExchange(req, this.journal.get(req.id)).catch(() => undefined);
      if (row) {
        this.journal.append({ id: req.id, state: 'submitted', ts: this.clock(), amount: req.amount, exchangeId: row.id });
        return this.fromRow(req, row);
      }
      return this.refuse(req, `exchange refused (${kind}): ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }

  /** The exchange's record of this withdrawal, if any. */
  private async findOnExchange(req: WithdrawRequestMsg, j: JournalEntry | undefined): Promise<MexcWithdrawRow | undefined> {
    const now = this.clock();
    const since = Math.max(now - HISTORY_MAX_MS, Math.min(req.createdTs, j?.ts ?? req.createdTs) - 3_600_000);
    const rows = await this.api.withdrawHistory(this.cfg.coin, since, now);
    const byId = rows.find((r) => r.withdrawOrderId === req.id || r.remark === req.id || (j?.exchangeId !== undefined && r.id === j.exchangeId));
    if (byId) return byId;
    // A call whose answer was lost: match by destination, amount and time (ours alone write here).
    if (j?.state === 'submitting') {
      const cands = rows.filter((r) => r.address === this.cfg.address && new BN(r.amount).eq(req.amount) && r.applyTime >= j.ts - 60_000 && r.applyTime <= j.ts + 10 * 60_000);
      if (cands.length === 1) return cands[0];
    }
    return undefined;
  }

  private fromRow(req: WithdrawRequestMsg, row: MexcWithdrawRow): WithdrawReport {
    const outcome = mexcWithdrawOutcome(row.status);
    const name = MEXC_WITHDRAW_STATUS[row.status] ?? `status ${row.status}`;
    const txId = row.txId ?? row.transHash ?? undefined;
    const base = { id: req.id, exchangeId: row.id, ...(txId ? { txId } : {}) };
    if (outcome === 'in_progress') return { ...base, status: 'SENT', reason: name };
    if (outcome === 'failed') return { ...base, status: 'FAILED', reason: `MEXC ${name}` };
    const fee = new BN(row.transactionFee ?? 0);
    // MEXC may report the gross amount, or the amount received (gross − fee): both settle the
    // reserve exactly. Anything else is reported as is (the engine halts on a mismatch).
    const gross = new BN(row.amount).eq(req.amount) || new BN(row.amount).plus(fee).eq(req.amount) ? req.amount : new BN(row.amount).toFixed();
    return { ...base, status: 'CONFIRMED', amount: gross, fee: fee.toFixed() };
  }
}

/** A human's final answer for an unresolved withdrawal (after checking MEXC by hand). */
export function resolveByHand(journal: Journal, id: string, status: 'CONFIRMED' | 'FAILED', fee: string | undefined, now: number): JournalEntry {
  const j = journal.get(id);
  if (!j) throw new Error(`withdrawal ${id} is not in the journal`);
  if (j.state === 'refused' || j.state === 'aborted' || j.state === 'resolved') throw new Error(`withdrawal ${id} is already final (${j.state})`);
  if (status === 'CONFIRMED' && (fee === undefined || !/^\d+(\.\d+)?$/.test(fee))) throw new Error('confirmed needs the fee MEXC charged, e.g. `resolve <id> confirmed 1`');
  const e: JournalEntry = { id, state: 'resolved', ts: now, status, ...(j.amount ? { amount: j.amount } : {}), ...(fee ? { fee } : {}), reason: 'resolved by a human' };
  journal.append(e);
  return e;
}
