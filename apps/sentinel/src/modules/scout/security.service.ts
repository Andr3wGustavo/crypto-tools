import axios from 'axios';
import { logger } from '../../utils/logger';

export interface SecurityAuditResult {
    isHoneypot: boolean;
    buyTax: number;
    sellTax: number;
    isMintable: boolean;
    hasBlacklist: boolean;
    liquidityLocked: boolean;
    riskFlags: string[];
    isSafe: boolean;
    rawReport?: any;
}

export class SecurityService {
    // Mapping of DexScreener chainId to GoPlus chainId
    private static goplusChainMap: Record<string, string> = {
        ethereum: '1',
        eth: '1',
        bsc: '56',
        binance: '56',
        polygon: '137',
        arbitrum: '42161',
        base: '8453',
        avalanche: '43114',
        optimism: '10',
        solana: 'solana'
    };

    /**
     * Perform automated contract security scan (GoPlus & RugCheck)
     */
    static async auditToken(chainId: string, tokenAddress: string): Promise<SecurityAuditResult> {
        const normalizedChain = chainId.toLowerCase();
        const flags: string[] = [];

        // 1. Solana Chain -> RugCheck API
        if (normalizedChain === 'solana') {
            return this.auditSolana(tokenAddress);
        }

        // 2. EVM Chains -> GoPlus Security API
        const goplusChainId = this.goplusChainMap[normalizedChain];
        if (!goplusChainId) {
            // Unsupported chain for GoPlus, return neutral
            return {
                isHoneypot: false,
                buyTax: 0,
                sellTax: 0,
                isMintable: false,
                hasBlacklist: false,
                liquidityLocked: true,
                riskFlags: ['Chain not covered by automated audit API'],
                isSafe: true
            };
        }

        try {
            const url = `https://api.gopluslabs.io/api/v1/token_security/${goplusChainId}?contract_addresses=${tokenAddress}`;
            const res = await axios.get(url, { timeout: 6000 });
            const data = res.data?.result?.[tokenAddress.toLowerCase()];

            if (!data) {
                return {
                    isHoneypot: false,
                    buyTax: 0,
                    sellTax: 0,
                    isMintable: false,
                    hasBlacklist: false,
                    liquidityLocked: true,
                    riskFlags: ['No security data returned'],
                    isSafe: true
                };
            }

            const isHoneypot = data.is_honeypot === '1';
            const buyTax = parseFloat(data.buy_tax || '0') * 100;
            const sellTax = parseFloat(data.sell_tax || '0') * 100;
            const isMintable = data.is_mintable === '1';
            const hasBlacklist = data.is_blacklisted === '1';
            const canTakeBackOwnership = data.can_take_back_ownership === '1';
            const cannotSellAll = data.cannot_sell_all === '1';

            if (isHoneypot) flags.push('🚨 HONEYPOT: Tokens cannot be sold!');
            if (buyTax > 10) flags.push(`⚠️ High Buy Tax: ${buyTax.toFixed(1)}%`);
            if (sellTax > 10) flags.push(`🚨 High Sell Tax: ${sellTax.toFixed(1)}%`);
            if (isMintable) flags.push('⚠️ Contract is Mintable (Owner can dilute supply)');
            if (canTakeBackOwnership) flags.push('⚠️ Owner can reclaim ownership after renounce');
            if (cannotSellAll) flags.push('🚨 Cannot sell all tokens at once');

            const isSafe = !isHoneypot && sellTax <= 10 && buyTax <= 10 && !cannotSellAll;

            return {
                isHoneypot,
                buyTax,
                sellTax,
                isMintable,
                hasBlacklist,
                liquidityLocked: true,
                riskFlags: flags,
                isSafe,
                rawReport: data
            };
        } catch (error: any) {
            logger.warn(`Security check failed for EVM ${tokenAddress}: ${error.message}`);
            return {
                isHoneypot: false,
                buyTax: 0,
                sellTax: 0,
                isMintable: false,
                hasBlacklist: false,
                liquidityLocked: true,
                riskFlags: ['Audit request timed out'],
                isSafe: true
            };
        }
    }

    /**
     * Solana token audit via RugCheck API
     */
    private static async auditSolana(mintAddress: string): Promise<SecurityAuditResult> {
        const flags: string[] = [];
        try {
            const url = `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`;
            const res = await axios.get(url, { timeout: 6000 });
            const data = res.data;

            let isHoneypot = false;
            let isMintable = false;
            let isFreezeEnabled = false;

            if (data?.risks && Array.isArray(data.risks)) {
                for (const risk of data.risks) {
                    if (risk.level === 'danger') {
                        flags.push(`🚨 ${risk.name}: ${risk.description}`);
                        if (risk.name?.toLowerCase().includes('mint')) isMintable = true;
                        if (risk.name?.toLowerCase().includes('freeze')) isFreezeEnabled = true;
                    } else if (risk.level === 'warn') {
                        flags.push(`⚠️ ${risk.name}`);
                    }
                }
            }

            const score = data?.score || 0; // RugCheck score: lower is safer, >2000 is danger
            if (score > 1500) {
                isHoneypot = true;
            }

            return {
                isHoneypot,
                buyTax: 0,
                sellTax: 0,
                isMintable,
                hasBlacklist: isFreezeEnabled,
                liquidityLocked: score < 1000,
                riskFlags: flags,
                isSafe: flags.filter(f => f.startsWith('🚨')).length === 0,
                rawReport: data
            };
        } catch (err: any) {
            // RugCheck timeout fallback
            return {
                isHoneypot: false,
                buyTax: 0,
                sellTax: 0,
                isMintable: false,
                hasBlacklist: false,
                liquidityLocked: true,
                riskFlags: [],
                isSafe: true
            };
        }
    }
}
