const axios = require('axios');
const crypto = require('crypto');
const config = require('../config/exchange');

class BinanceAdapter {
    constructor(apiKey, secret) {
        this.apiKey = apiKey;
        this.secret = secret;
        this.baseUrl = config.baseUrl;
    }

    _sign(query) {
        // query string must be bare for signature? Binance needs the exact query string
        return crypto.createHmac('sha256', this.secret).update(query).digest('hex');
    }

    async _request(method, endpoint, params = {}, signed = false) {
        // For signed requests, we need timestamp
        if (signed) {
            params.timestamp = Date.now();
        }

        // Convert params to query string sorted (though Binance only needs order for signature to match query)
        // URLSearchParams handles encoding well
        let query = new URLSearchParams(params).toString();

        if (signed) {
            const signature = this._sign(query);
            query += `&signature=${signature}`;
        }

        const url = `${this.baseUrl}${endpoint}?${query}`;

        try {
            const config = {
                method,
                url,
                headers: {
                    'Content-Type': 'application/json'
                }
            };
            if (signed || endpoint.includes('api')) { // Always send API Key if available, but mandatory for signed
                config.headers['X-MBX-APIKEY'] = this.apiKey;
            }

            const result = await axios(config);
            return result.data;
        } catch (e) {
            // Log error but don't crash loop
            // console.error(`API Error ${endpoint}:`, e.response ? e.response.data : e.message);
            throw e;
        }
    }

    async getOrderBook(symbol) {
        // limit 5 is enough for BBO (Best Bid Offer)
        return this._request('GET', '/api/v3/depth', { symbol, limit: 10 });
    }

    async getAccount(symbol) {
        // Get account info
        return this._request('GET', '/api/v3/account', {}, true);
    }

    // Place LIMIT MAKER order (Post Only usually)
    async placeOrder(symbol, side, quantity, price) {
        const params = {
            symbol,
            side: side.toUpperCase(),
            type: 'LIMIT_MAKER', // This enforces Maker side or fails (Post Only)
            quantity: quantity,
            price: price
        };
        // LIMIT_MAKER implies GTC typically in Binance, no need for timeInForce param if type is LIMIT_MAKER

        return this._request('POST', '/api/v3/order', params, true);
    }

    async cancelOrder(symbol, orderId) {
        return this._request('DELETE', '/api/v3/order', { symbol, orderId }, true);
    }

    async cancelAllOrders(symbol) {
        return this._request('DELETE', '/api/v3/openOrders', { symbol }, true);
    }

    async getOpenOrders(symbol) {
        return this._request('GET', '/api/v3/openOrders', { symbol }, true);
    }
}

module.exports = BinanceAdapter;
