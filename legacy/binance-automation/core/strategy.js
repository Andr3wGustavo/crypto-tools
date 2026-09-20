const { updateMid, calcRespiro } = require('./spreadRespiro')

function decide({ bid, ask, feeMaker, margem, inventoryPct, riskConfig, bookImbalance }) {
    const mid = updateMid(bid, ask)
    const respiro = calcRespiro()

    // 1. Dynamic Spread Calculation
    // spread = max(Fee*2 + Margem, k1 * Respiro, k2 * Imbalance)
    const cost = 2 * feeMaker + margem
    const volatilityComponent = respiro * (riskConfig.k1_ATR || 1)
    const imbalanceComponent = bookImbalance * (riskConfig.k2_Imbalance || 0)

    // Spread must cover cost, but also expand with volatility/imbalance
    const targetSpread = Math.max(cost, volatilityComponent, imbalanceComponent)

    // 2. Inventory Skew
    // If we have too much inventory (Long), we want to Sell (Ask lower, Bid lower)
    // inventoryPct is e.g. 0.1 (10% of max pos). 
    // Let's assume inventoryPct is relative to "Target". 
    // For simplicity: inventoryPct = (currentBase * price) / maxPosition. 
    // If Target is 0, then any positive inventory is "Long".

    // Skew calculation:
    // shift = (inventoryPct - target) * skewFactor
    const targetInv = riskConfig.inventoryTarget || 0
    const inventoryDev = (inventoryPct || 0) - targetInv
    const skew = inventoryDev * (riskConfig.skewFactor || 0)

    // Apply Skew:
    // If skew > 0 (Too Long), we shift DOWN mid effective
    // effectiveMid = mid * (1 - skew)
    const effectiveMid = mid * (1 - skew)

    // Check Entry Gate
    // We still use the "Breathing" (Respiro) as a gate?
    // Or is the spread expansion enough?
    // Original logic: if (respiro <= cost) return false.
    // Now: if calculated spread < cost, we implicitly don't trade if we forced spread = cost?
    // Actually, we should only trade if market volatility allows "capture". 
    // If we just set spread = cost in a flat market, we might never fill or fill and never exit.
    // We keep the gate: if volatility is super low, staying out is safer (avoid adverse selection on sudden move).

    if (respiro < feeMaker) { // Very strict gate, at least cover 1 leg fee in volatility
        return { action: false, mid, spread: targetSpread, respiro }
    }

    const halfSpread = targetSpread / 2

    return {
        action: true,
        buyPrice: effectiveMid * (1 - halfSpread),
        sellPrice: effectiveMid * (1 + halfSpread),
        mid: effectiveMid, // Return skewed mid for logs
        spread: targetSpread,
        respiro,
        skew
    }
}

module.exports = { decide }
