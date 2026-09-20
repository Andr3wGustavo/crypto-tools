import { DexToken } from './dexscreener';
import { config } from '../config/env';

export class FilterService {
    static filter(pair: DexToken): { passed: boolean; reason?: string } {
        // 1. Liquidity Check
        if (pair.liquidity.usd < config.MIN_LIQUIDITY) {
            return { passed: false, reason: `Low Liquidity: $${pair.liquidity.usd}` };
        }

        // 2. Volume Check (24h)
        if (pair.volume.h24 < config.MIN_VOLUME) {
            return { passed: false, reason: `Low Volume: $${pair.volume.h24}` };
        }

        // 3. Age Check (Optional - e.g., skip if too old? or too young?)
        // For "new coins", we might want pairs created recently.
        // pair.pairCreatedAt is a timestamp.
        const now = Date.now();
        const ageHours = (now - pair.pairCreatedAt) / (1000 * 60 * 60);

        // Example: If we want only coins younger than 7 days
        // if (ageHours > 168) return { passed: false, reason: "Too old" };

        // 4. FDV Check (Avoid super high FDV scams or super low)
        if (pair.fdv > 1000000000) { // 1B
            // Maybe a warning, but not a hard filter?
        }

        return { passed: true };
    }
}
