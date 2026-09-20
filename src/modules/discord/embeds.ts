import { EmbedBuilder } from 'discord.js';
import { DexPair } from '../scout/dexscreener.service';
import { SecurityAuditResult } from '../scout/security.service';
import { AIDueDiligenceReport } from '../ai/gemini.service';
import { MacroMarketData } from '../market/macro.service';
import { PositionAlert } from '../tracker/gain-tracker.service';

export class DiscordEmbedFactory {
    /**
     * Create rich embed for discovered or analyzed token
     */
    static createTokenEmbed(pair: DexPair, security?: SecurityAuditResult, ai?: AIDueDiligenceReport): EmbedBuilder {
        const score = ai?.score ?? 50;
        const color = score >= 80 ? 0x00FF88 : score >= 50 ? 0xFFA500 : 0xFF2244;

        const embed = new EmbedBuilder()
            .setTitle(`${score >= 80 ? '💎 GEM DETECTED' : '⚡ TOKEN REPORT'}: ${pair.baseToken.name} ($${pair.baseToken.symbol})`)
            .setURL(pair.url)
            .setColor(color)
            .setDescription(ai?.summary || 'Automated due diligence audit completed.')
            .addFields(
                { name: '💵 Price', value: `$${pair.priceUsd}`, inline: true },
                { name: '💧 Liquidity', value: `$${(pair.liquidity?.usd || 0).toLocaleString()}`, inline: true },
                { name: '📊 FDV', value: `$${(pair.fdv || 0).toLocaleString()}`, inline: true },
                { name: '📈 24h Volume', value: `$${(pair.volume?.h24 || 0).toLocaleString()}`, inline: true },
                { name: '🕒 24h Change', value: `${pair.priceChange?.h24}%`, inline: true },
                { name: '🧠 AI Score', value: `**${score}/100** (${ai?.sentiment || 'ANALYZED'})`, inline: true },
                {
                    name: '🛡️ Security Audit',
                    value: security?.isHoneypot
                        ? '🚨 **HONEYPOT DETECTED**'
                        : `✅ Honeypot: Free | Buy Tax: ${security?.buyTax.toFixed(1)}% | Sell Tax: ${security?.sellTax.toFixed(1)}%`,
                    inline: false
                }
            );

        if (ai?.strengths && ai.strengths.length > 0) {
            embed.addFields({ name: '🌟 Strengths', value: ai.strengths.map(s => `• ${s}`).join('\n') });
        }

        if (ai?.risks && ai.risks.length > 0) {
            embed.addFields({ name: '⚠️ Risk Factors', value: ai.risks.map(r => `• ${r}`).join('\n') });
        }

        if (pair.info?.imageUrl) {
            embed.setThumbnail(pair.info.imageUrl);
        }

        embed.setFooter({ text: `DexScreener • Chain: ${pair.chainId.toUpperCase()} • DEX: ${pair.dexId.toUpperCase()}` })
            .setTimestamp();

        return embed;
    }

    /**
     * Create macro market overview embed
     */
    static createMacroEmbed(data: MacroMarketData): EmbedBuilder {
        const fng = data.fearAndGreed;
        const color = fng.value > 60 ? 0x00FF88 : fng.value < 40 ? 0xFF3333 : 0xFFAA00;

        return new EmbedBuilder()
            .setTitle('🌐 Crypto Macro Market Overview')
            .setColor(color)
            .addFields(
                { name: '😱 Fear & Greed Index', value: `**${fng.value}/100** (${fng.classification})`, inline: true },
                { name: '₿ Bitcoin (BTC)', value: `$${data.btcPriceUsd.toLocaleString()}`, inline: true },
                { name: 'Ξ Ethereum (ETH)', value: `$${data.ethPriceUsd.toLocaleString()}`, inline: true }
            )
            .setFooter({ text: 'Alternative.me & Binance Market Data' })
            .setTimestamp();
    }

    /**
     * Create position milestone or trailing stop alert embed
     */
    static createPositionAlertEmbed(alert: PositionAlert): EmbedBuilder {
        const isStop = alert.type === 'TRAILING_STOP';
        return new EmbedBuilder()
            .setTitle(isStop ? '🛑 TRAILING STOP TRIGGERED' : '🎯 TAKE PROFIT MILESTONE')
            .setColor(isStop ? 0xFF0033 : 0x00E676)
            .setDescription(alert.message)
            .addFields(
                { name: 'Token', value: alert.symbol, inline: true },
                { name: 'Current PnL', value: `${alert.gainPct >= 0 ? '+' : ''}${alert.gainPct.toFixed(1)}%`, inline: true },
                { name: 'Current Price', value: `$${alert.currentPrice}`, inline: true }
            )
            .setTimestamp();
    }
}
