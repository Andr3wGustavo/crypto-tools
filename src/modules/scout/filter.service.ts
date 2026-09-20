import { DexPair } from './dexscreener.service';
import { SecurityAuditResult } from './security.service';
import { env } from '../../config/env';

export interface FilterEvaluation {
    passed: boolean;
    reason?: string;
    metrics: {
        liquidityUsd: number;
        volume24h: number;
        ageHours: number;
        fdv: number;
    };
}

export class FilterService {
    static evaluate(pair: DexPair, security?: SecurityAuditResult): FilterEvaluation {
        const liquidityUsd = pair.liquidity?.usd || 0;
        const volume24h = pair.volume?.h24 || 0;
        const now = Date.now();
        const pairCreatedAt = pair.pairCreatedAt || now;
        const ageHours = (now - pairCreatedAt) / (1000 * 60 * 60);
        const fdv = pair.fdv || 0;

        const metrics = { liquidityUsd, volume24h, ageHours, fdv };

        // 1. Critical Security Check
        if (security && !security.isSafe) {
            return {
                passed: false,
                reason: `Security Failure: ${security.riskFlags.join(', ')}`,
                metrics
            };
        }

        // 2. Minimum Liquidity Check
        if (liquidityUsd < env.MIN_LIQUIDITY_USD) {
            return {
                passed: false,
                reason: `Insufficient Liquidity: $${liquidityUsd.toLocaleString()} < $${env.MIN_LIQUIDITY_USD.toLocaleString()}`,
                metrics
            };
        }

        // 3. Minimum 24h Volume Check
        if (volume24h < env.MIN_VOLUME_USD_24H) {
            return {
                passed: false,
                reason: `Insufficient Volume: $${volume24h.toLocaleString()} < $${env.MIN_VOLUME_USD_24H.toLocaleString()}`,
                metrics
            };
        }

        // 4. Age Check (optional ceiling)
        if (env.MAX_AGE_HOURS > 0 && ageHours > env.MAX_AGE_HOURS) {
            return {
                passed: false,
                reason: `Pair older than threshold: ${ageHours.toFixed(1)}h > ${env.MAX_AGE_HOURS}h`,
                metrics
            };
        }

        // 5. Extreme Imbalance Checks (e.g. FDV $100M with only $15K liquidity -> High manipulation risk)
        if (liquidityUsd > 0 && fdv > 0) {
            const fdvToLiqRatio = fdv / liquidityUsd;
            if (fdvToLiqRatio > 200) {
                return {
                    passed: false,
                    reason: `Suspicious FDV/Liquidity ratio: ${(fdvToLiqRatio).toFixed(1)}x (High dump risk)`,
                    metrics
                };
            }
        }

        return { passed: true, metrics };
    }
}
