module.exports = {
    margem: 0.0005,      // 0.05% safety margin on top of fees
    maxOrderTime: 10000,           // 10 seconds max life for an order (fallback)
    ttlMultiplier: 50,             // TTL = respiro * ttlMultiplier (Adaptive)
    driftThreshold: 0.002,         // 0.2% price move cancels orders
    minSize: 15,                   // Min order size in USDT/USDC
    maxPosition: 50,               // Max allocation per cycle (Capital Efficiency)
    cancelThreshold: 10,           // Max specific cancels per minute before pause

    // v2.0 Dynamic Spread & Skew
    k1_ATR: 2.0,                   // Multiplier for Breathing/ATR to Spread
    k2_Imbalance: 0.5,             // Multiplier for Book Imbalance to Spread
    skewFactor: 0.001,             // How much to shift quotes per % of inventory deviation
    inventoryTarget: 0.5,           // Target inventory ratio (0.5 = 50% base / 50% quote ideally, or 0 if pure ping-pong)

    // Safety
    dailyStopLoss: -0.01           // -1% Daily Hard Stop
}
