require('dotenv').config()
const BinanceAdapter = require('./adapters/binance')
const { decide } = require('./core/strategy')
const { logDiscord } = require('./services/discordLogger')
const config = require('./config/exchange')
const fees = require('./config/fees')
const risk = require('./config/risk')

// Globals
const binance = new BinanceAdapter(process.env.BINANCE_API_KEY, process.env.BINANCE_SECRET)
let cycleCount = 0
let startBalance = 0
let initialCapitalValue = 0 // To track net PnL %

// Stats
let stats = {
    totalSpread: 0,
    cycles: 0,
    startTime: Date.now()
}

// Sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function getPortfolioState() {
    try {
        const account = await binance.getAccount()
        // Account has balances array
        const baseAsset = config.symbol.replace('USDC', '').replace('USDT', '') // e.g. BTC
        const quoteAsset = config.symbol.endsWith('USDC') ? 'USDC' : 'USDT'

        const baseBal = account.balances.find(b => b.asset === baseAsset)
        const quoteBal = account.balances.find(b => b.asset === quoteAsset)

        return {
            base: parseFloat(baseBal ? baseBal.free : 0) + parseFloat(baseBal ? baseBal.locked : 0),
            quote: parseFloat(quoteBal ? quoteBal.free : 0) + parseFloat(quoteBal ? quoteBal.locked : 0)
        }
    } catch (e) {
        console.error("Failed to get portfolio:", e.message)
        return null
    }
}

async function run() {
    console.log('Starting Micro MM Bot v2.0 (Hedge Fund Edition)...')

    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET) {
        console.error("❌ CRITICAL ERROR: Missing BINANCE_API_KEY or BINANCE_SECRET in .env file.")
        console.error("Please create a .env file based on .env.example and add your keys.")
        process.exit(1)
    }

    await logDiscord("🟢 Micro MM Bot v2.0 Started")

    // Init Balance
    const initial = await getPortfolioState()
    if (!initial) {
        console.error("Could not fetch initial balance. Aborting.")
        return
    }
    // Approx value (fetch price first)
    const book0 = await binance.getOrderBook(config.symbol)
    const mid0 = (parseFloat(book0.bids[0][0]) + parseFloat(book0.asks[0][0])) / 2
    initialCapitalValue = initial.quote + (initial.base * mid0)
    startBalance = initialCapitalValue

    console.log(`Initial Capital: $${initialCapitalValue.toFixed(2)} USD`)

    while (true) {
        try {
            // 0. Financial Health Check (Daily Hard Stop)
            const currentPortfolio = await getPortfolioState()
            if (!currentPortfolio) { await sleep(2000); continue; }

            // 1. Get Depth (Book) & Imbalance
            const book = await binance.getOrderBook(config.symbol)
            const bid = parseFloat(book.bids[0][0])
            const ask = parseFloat(book.asks[0][0])

            // Simple Imbalance: (BidVol - AskVol) / (BidVol + AskVol) (Top 1 level for speed or sum of 5?)
            // Let's use Top 5 sum
            let bidVol = 0, askVol = 0
            for (let i = 0; i < Math.min(book.bids.length, 5); i++) bidVol += parseFloat(book.bids[i][1])
            for (let i = 0; i < Math.min(book.asks.length, 5); i++) askVol += parseFloat(book.asks[i][1])

            const imbalance = (bidVol - askVol) / (bidVol + askVol) // Range -1 to 1

            // 2. Inventory Calculation
            const currentMid = (bid + ask) / 2
            const currentValue = currentPortfolio.quote + (currentPortfolio.base * currentMid)
            const pnlPct = (currentValue - startBalance) / startBalance

            if (pnlPct < risk.dailyStopLoss) {
                console.error(`🚨 HARD STOP TRIPPED: PnL ${(pnlPct * 100).toFixed(2)}% < ${(risk.dailyStopLoss * 100).toFixed(2)}%`)
                await logDiscord(`🚨 HARD STOP: Trading Halted. PnL: ${(pnlPct * 100).toFixed(2)}%`)
                process.exit(0)
            }

            // Inventory % uses MaxPosition from risk
            const baseValue = currentPortfolio.base * currentMid
            const inventoryPct = baseValue / risk.maxPosition // e.g. 20 USD / 50 Max = 0.4

            // 3. Decide (v2.0)
            const decision = decide({
                bid,
                ask,
                feeMaker: fees.maker,
                margem: risk.margem,
                inventoryPct,
                riskConfig: risk,
                bookImbalance: Math.abs(imbalance) // Magnitude of imbalance expands spread
            })

            // If no action
            if (!decision || !decision.action) {
                process.stdout.write('.')
                await sleep(1000)
                continue
            }

            console.log(`\nCycle ${++cycleCount} | Spread: ${(decision.spread * 100).toFixed(4)}% | Skew: ${(decision.skew * 100).toFixed(4)}% | Inv: ${(inventoryPct * 100).toFixed(1)}%`)

            // Log Financials occasionally
            if (cycleCount % 10 === 0) {
                const hours = (Date.now() - stats.startTime) / 3600000
                console.log(`📊 Stats: ${(cycleCount / hours).toFixed(1)} cycles/hr | PnL: ${(pnlPct * 100).toFixed(4)}% ($${(currentValue - startBalance).toFixed(4)})`)
            }

            // 4. Execution Logic
            try {
                await binance.cancelAllOrders(config.symbol)
            } catch (e) { }

            const qtyPrecision = 5
            const pricePrecision = 2
            const quantity = (risk.minSize / decision.mid).toFixed(qtyPrecision)
            const buyPrice = decision.buyPrice.toFixed(pricePrecision)
            const sellPrice = decision.sellPrice.toFixed(pricePrecision)

            // Dynamic TTL
            let dynamicTTL = Math.floor(decision.respiro * risk.ttlMultiplier * 1000)
            if (dynamicTTL < 3000) dynamicTTL = 3000
            if (dynamicTTL > risk.maxOrderTime) dynamicTTL = risk.maxOrderTime

            const orders = await Promise.allSettled([
                binance.placeOrder(config.symbol, 'BUY', quantity, buyPrice),
                binance.placeOrder(config.symbol, 'SELL', quantity, sellPrice)
            ])

            const successful = orders.filter(o => o.status === 'fulfilled')
            if (successful.length === 0) {
                console.log('Orders rejected')
                await sleep(1000)
                continue
            }

            logDiscord({
                event: 'Cycle Open v2',
                spread: `${(decision.spread * 100).toFixed(4)}%`,
                inv: `${(inventoryPct * 100).toFixed(1)}%`,
                skew: `${(decision.skew * 100).toFixed(4)}%`,
                pnl: `$${(currentValue - startBalance).toFixed(4)}`,
                buy: buyPrice,
                sell: sellPrice
            })

            // Monitor Loop
            const startTime = Date.now()
            let ordersLife = 0

            while (ordersLife < dynamicTTL) {
                const currentBook = await binance.getOrderBook(config.symbol)
                const currentBid = parseFloat(currentBook.bids[0][0])
                const currentAsk = parseFloat(currentBook.asks[0][0])
                const tickMid = (currentBid + currentAsk) / 2

                // Drift vs Effective Mid (Skewed)
                const drift = Math.abs((tickMid - decision.mid) / decision.mid)

                if (drift > risk.driftThreshold) {
                    console.log(`🚨 Drift ${(drift * 100).toFixed(3)}%. Cancelling.`)
                    break
                }

                await sleep(500)
                ordersLife = Date.now() - startTime
            }

            try { await binance.cancelAllOrders(config.symbol) } catch (e) { }
            await sleep(500)

        } catch (err) {
            console.error('Cycle Error:', err.message)
            await sleep(5000)
        }
    }
}

run()
