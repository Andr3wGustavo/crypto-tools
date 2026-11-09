import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';
import crypto from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

export interface WithdrawResult {
    success: boolean;
    amount: number;
    asset: string;
    destination: string;
    txId: string;
    mode: 'solana' | 'binance' | 'none';
    error?: string;
}

export class AutoWithdrawService {
    private mode: 'solana' | 'binance' | 'none';
    private solanaConnection: Connection | null = null;
    private solanaKeypair: Keypair | null = null;
    private binanceApiKey: string;
    private binanceSecret: string;
    private binanceBaseUrl: string;

    constructor() {
        this.binanceApiKey = env.BINANCE_API_KEY;
        this.binanceSecret = env.BINANCE_SECRET;
        this.binanceBaseUrl = env.BINANCE_TESTNET ? env.BINANCE_TESTNET_BASE_URL : env.BINANCE_BASE_URL;

        // Determine mode
        if (env.SOLANA_PRIVATE_KEY && env.SOLANA_PRIVATE_KEY.length > 0) {
            this.mode = 'solana';
            this.initSolana();
        } else if (this.binanceApiKey && this.binanceSecret) {
            this.mode = 'binance';
        } else {
            this.mode = 'none';
            logger.warn('[AutoWithdraw] No withdrawal credentials configured. Withdrawals disabled.');
        }

        logger.info(`[AutoWithdraw] Mode: ${this.mode}`);
    }

    private initSolana() {
        try {
            const decoded = bs58.decode(env.SOLANA_PRIVATE_KEY);
            this.solanaKeypair = Keypair.fromSecretKey(decoded);
            this.solanaConnection = new Connection(env.SOLANA_RPC_URL, 'confirmed');
            logger.info(`[AutoWithdraw] Solana wallet: ${this.solanaKeypair.publicKey.toBase58()}`);
        } catch (err: any) {
            logger.error(`[AutoWithdraw] Failed to init Solana: ${err.message}`);
            this.mode = 'none';
        }
    }

    /**
     * Withdraw profit to destination wallet.
     * @param amount - amount to withdraw (in quote currency, e.g. USDT or SOL)
     * @param asset - asset to withdraw (e.g. 'USDT', 'SOL', 'BTC')
     * @param destination - destination address (Solana pubkey or Binance address)
     */
    async withdraw(amount: number, asset: string, destination: string): Promise<WithdrawResult> {
        if (this.mode === 'none') {
            logger.warn('[AutoWithdraw] Withdrawal disabled. Skipping.');
            return { success: false, amount, asset, destination, txId: '', mode: 'none', error: 'No credentials' };
        }

        if (this.mode === 'solana') {
            return this.withdrawSolana(amount, asset, destination);
        } else {
            return this.withdrawBinance(amount, asset, destination);
        }
    }

    private async withdrawSolana(amount: number, asset: string, destination: string): Promise<WithdrawResult> {
        if (!this.solanaConnection || !this.solanaKeypair) {
            return { success: false, amount, asset, destination, txId: '', mode: 'solana', error: 'Not initialized' };
        }

        try {
            const toPubkey = new PublicKey(destination);
            const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: this.solanaKeypair.publicKey,
                    toPubkey,
                    lamports
                })
            );

            const { blockhash } = await this.solanaConnection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = this.solanaKeypair.publicKey;

            transaction.sign(this.solanaKeypair);
            const txId = await this.solanaConnection.sendRawTransaction(transaction.serialize());
            await this.solanaConnection.confirmTransaction(txId, 'confirmed');

            logger.info(`[AutoWithdraw] Solana transfer: ${amount} SOL -> ${destination} tx=${txId}`);
            return { success: true, amount, asset, destination, txId, mode: 'solana' };
        } catch (err: any) {
            logger.error(`[AutoWithdraw] Solana transfer failed: ${err.message}`);
            return { success: false, amount, asset, destination, txId: '', mode: 'solana', error: err.message };
        }
    }

    private async withdrawBinance(amount: number, asset: string, destination: string): Promise<WithdrawResult> {
        try {
            const params: Record<string, any> = {
                coin: asset,
                address: destination,
                amount: amount.toString(),
                network: asset === 'USDT' ? 'BSC' : undefined
            };

            // Sign request
            const queryString = new URLSearchParams(params).toString() + `&timestamp=${Date.now()}`;
            const signature = crypto.createHmac('sha256', this.binanceSecret).update(queryString).digest('hex');
            const signedQuery = queryString + `&signature=${signature}`;

            const res = await axios.post(
                `${this.binanceBaseUrl}/sapi/v1/capital/withdraw/apply?${signedQuery}`,
                {},
                { headers: { 'X-MBX-APIKEY': this.binanceApiKey }, timeout: 10000 }
            );

            const txId = res.data?.id || '';
            logger.info(`[AutoWithdraw] Binance withdraw: ${amount} ${asset} -> ${destination} id=${txId}`);
            return { success: true, amount, asset, destination, txId, mode: 'binance' };
        } catch (err: any) {
            const msg = err.response?.data?.msg || err.message;
            logger.error(`[AutoWithdraw] Binance withdraw failed: ${msg}`);
            return { success: false, amount, asset, destination, txId: '', mode: 'binance', error: msg };
        }
    }

    getMode(): string {
        return this.mode;
    }
}