import axios from 'axios';
import crypto from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

export class BinanceAdapter {
    private apiKey: string;
    private secret: string;
    private baseUrl: string;

    constructor(apiKey = env.BINANCE_API_KEY, secret = env.BINANCE_SECRET, baseUrl = env.BINANCE_TESTNET ? env.BINANCE_TESTNET_BASE_URL : env.BINANCE_BASE_URL) {
        this.apiKey = apiKey;
        this.secret = secret;
        this.baseUrl = baseUrl;
    }

    private sign(queryString: string): string {
        return crypto.createHmac('sha256', this.secret).update(queryString).digest('hex');
    }

    async request<T = any>(method: string, endpoint: string, params: Record<string, any> = {}, signed = false): Promise<T> {
        if (signed) {
            params.timestamp = Date.now();
        }

        let queryString = new URLSearchParams(params).toString();
        if (signed) {
            const signature = this.sign(queryString);
            queryString += `&signature=${signature}`;
        }

        const url = `${this.baseUrl}${endpoint}${queryString ? `?${queryString}` : ''}`;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        if (this.apiKey) {
            headers['X-MBX-APIKEY'] = this.apiKey;
        }

        try {
            const response = await axios({ method, url, headers, timeout: 5000 });
            return response.data;
        } catch (error: any) {
            const msg = error.response?.data?.msg || error.message;
            logger.error(`Binance API Error on ${endpoint}: ${msg}`);
            throw new Error(`Binance Error: ${msg}`);
        }
    }

    async getAccount() {
        return this.request('GET', '/api/v3/account', {}, true);
    }

    async getOrderBook(symbol: string, limit = 10) {
        return this.request('GET', '/api/v3/depth', { symbol: symbol.toUpperCase(), limit }, false);
    }

    async placeLimitMaker(symbol: string, side: 'BUY' | 'SELL', quantity: string, price: string) {
        const params = {
            symbol: symbol.toUpperCase(),
            side,
            type: 'LIMIT_MAKER',
            quantity,
            price
        };
        return this.request('POST', '/api/v3/order', params, true);
    }

    async cancelOrder(symbol: string, orderId: string | number) {
        return this.request('DELETE', '/api/v3/order', { symbol: symbol.toUpperCase(), orderId }, true);
    }

    async cancelAllOrders(symbol: string) {
        return this.request('DELETE', '/api/v3/openOrders', { symbol: symbol.toUpperCase() }, true);
    }

    async getOpenOrders(symbol: string) {
        return this.request('GET', '/api/v3/openOrders', { symbol: symbol.toUpperCase() }, true);
    }
}
