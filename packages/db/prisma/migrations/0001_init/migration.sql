-- TimescaleDB must exist before hypertables are created.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- CreateEnum
CREATE TYPE "TradingMode" AS ENUM ('shadow', 'live');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('INTENT', 'SENT', 'NEW', 'PARTIAL', 'FILLED', 'CANCEL_REQ', 'CANCELED', 'REJECTED', 'EXPIRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RiskSeverity" AS ENUM ('info', 'reduce_only', 'pause', 'halt', 'kill');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'SENT', 'CONFIRMED', 'FAILED');

-- CreateTable
CREATE TABLE "Bot" (
    "id" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'stopped',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotConfig" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "params" JSONB NOT NULL,
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "BotConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "botId" TEXT,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id","ts")
);

-- CreateTable
CREATE TABLE "Order" (
    "clientOrderId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "venue" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "filledQty" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL,
    "exchangeOrderId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("clientOrderId")
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" TEXT NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "side" "OrderSide" NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "quoteQty" DECIMAL(38,18) NOT NULL,
    "fee" DECIMAL(38,18) NOT NULL,
    "feeAsset" TEXT NOT NULL,
    "isMaker" BOOLEAN NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerTx" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "botId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT,
    "memo" TEXT,

    CONSTRAINT "LedgerTx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" BIGSERIAL NOT NULL,
    "txId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equity_snapshots" (
    "botId" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "equity" DOUBLE PRECISION NOT NULL,
    "cash" DOUBLE PRECISION NOT NULL,
    "treasury" DOUBLE PRECISION NOT NULL,
    "inventoryQty" DOUBLE PRECISION NOT NULL,
    "inventoryValue" DOUBLE PRECISION NOT NULL,
    "realizedPnl" DOUBLE PRECISION NOT NULL,
    "unrealizedPnl" DOUBLE PRECISION NOT NULL,
    "fees" DOUBLE PRECISION NOT NULL,
    "mid" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "equity_snapshots_pkey" PRIMARY KEY ("botId","ts")
);

-- CreateTable
CREATE TABLE "quote_samples" (
    "botId" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "fair" DOUBLE PRECISION NOT NULL,
    "bid" DOUBLE PRECISION,
    "ask" DOUBLE PRECISION,
    "halfSpreadBps" DOUBLE PRECISION NOT NULL,
    "skewBps" DOUBLE PRECISION NOT NULL,
    "sigmaBps" DOUBLE PRECISION NOT NULL,
    "toxic" BOOLEAN NOT NULL,

    CONSTRAINT "quote_samples_pkey" PRIMARY KEY ("botId","ts")
);

-- CreateTable
CREATE TABLE "Markout" (
    "fillId" TEXT NOT NULL,
    "horizonMs" INTEGER NOT NULL,
    "botId" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "bps" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Markout_pkey" PRIMARY KEY ("fillId","horizonMs")
);

-- CreateTable
CREATE TABLE "log_entries" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "level" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "botId" TEXT,
    "msg" TEXT NOT NULL,
    "data" JSONB,

    CONSTRAINT "log_entries_pkey" PRIMARY KEY ("id","ts")
);

-- CreateTable
CREATE TABLE "EdgeState" (
    "botId" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "n" INTEGER NOT NULL,
    "mean" DOUBLE PRECISION NOT NULL,
    "m2" DOUBLE PRECISION NOT NULL,
    "prior" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EdgeState_pkey" PRIMARY KEY ("botId")
);

-- CreateTable
CREATE TABLE "RiskEvent" (
    "id" TEXT NOT NULL,
    "botId" TEXT,
    "ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "severity" "RiskSeverity" NOT NULL,
    "rule" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "RiskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapitalStage" (
    "botId" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startEquity" DOUBLE PRECISION NOT NULL,
    "note" TEXT,

    CONSTRAINT "CapitalStage_pkey" PRIMARY KEY ("botId")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL,
    "asset" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "fee" DECIMAL(38,18),
    "exchangeId" TEXT,
    "txHash" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "data" JSONB,
    "ip" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "dexId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "imageUrl" TEXT,
    "liquidity" DOUBLE PRECISION NOT NULL,
    "fdv" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "priceNative" TEXT,
    "volume24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priceChange24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pairCreatedAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isHoneypot" BOOLEAN NOT NULL DEFAULT false,
    "buyTax" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sellTax" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isMintable" BOOLEAN NOT NULL DEFAULT false,
    "hasBlacklist" BOOLEAN NOT NULL DEFAULT false,
    "liquidityLocked" BOOLEAN NOT NULL DEFAULT false,
    "securityReport" TEXT,
    "riskScore" INTEGER,
    "aiAnalysis" TEXT,
    "isScam" BOOLEAN NOT NULL DEFAULT false,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "embedding" TEXT,
    "tags" TEXT,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenLog" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT,
    "symbol" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "currentPrice" DOUBLE PRECISION NOT NULL,
    "peakPrice" DOUBLE PRECISION NOT NULL,
    "currentGainPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "highestGainPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "trailingStopPct" DOUBLE PRECISION NOT NULL DEFAULT 15.0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MacroMetric" (
    "id" TEXT NOT NULL,
    "fearAndGreedIndex" INTEGER NOT NULL,
    "fearAndGreedSentiment" TEXT NOT NULL,
    "btcDominance" DOUBLE PRECISION,
    "ethGasGwei" DOUBLE PRECISION,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MacroMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotConfig_botId_version_key" ON "BotConfig"("botId", "version");

-- CreateIndex
CREATE INDEX "events_botId_ts_idx" ON "events"("botId", "ts");

-- CreateIndex
CREATE INDEX "events_type_ts_idx" ON "events"("type", "ts");

-- CreateIndex
CREATE INDEX "Order_botId_status_idx" ON "Order"("botId", "status");

-- CreateIndex
CREATE INDEX "Order_botId_createdAt_idx" ON "Order"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "Fill_botId_ts_idx" ON "Fill"("botId", "ts");

-- CreateIndex
CREATE INDEX "LedgerTx_botId_ts_idx" ON "LedgerTx"("botId", "ts");

-- CreateIndex
CREATE INDEX "LedgerTx_kind_ts_idx" ON "LedgerTx"("kind", "ts");

-- CreateIndex
CREATE INDEX "LedgerEntry_account_idx" ON "LedgerEntry"("account");

-- CreateIndex
CREATE INDEX "LedgerEntry_txId_idx" ON "LedgerEntry"("txId");

-- CreateIndex
CREATE INDEX "Markout_botId_ts_idx" ON "Markout"("botId", "ts");

-- CreateIndex
CREATE INDEX "log_entries_service_ts_idx" ON "log_entries"("service", "ts");

-- CreateIndex
CREATE INDEX "RiskEvent_botId_ts_idx" ON "RiskEvent"("botId", "ts");

-- CreateIndex
CREATE INDEX "Withdrawal_botId_createdAt_idx" ON "Withdrawal"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_ts_idx" ON "AuditLog"("ts");

-- CreateIndex
CREATE UNIQUE INDEX "Token_address_key" ON "Token"("address");

-- AddForeignKey
ALTER TABLE "BotConfig" ADD CONSTRAINT "BotConfig_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_clientOrderId_fkey" FOREIGN KEY ("clientOrderId") REFERENCES "Order"("clientOrderId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_txId_fkey" FOREIGN KEY ("txId") REFERENCES "LedgerTx"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenLog" ADD CONSTRAINT "TokenLog_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===================== TimescaleDB: hypertables, retention, compression =====================
SELECT create_hypertable('events', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('equity_snapshots', by_range('ts', INTERVAL '7 days'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('quote_samples', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('log_entries', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE);

SELECT add_retention_policy('quote_samples', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('log_entries', INTERVAL '7 days', if_not_exists => TRUE);


-- Append-only guarantee for the event log and the ledger (no UPDATE / DELETE, ever).
CREATE OR REPLACE FUNCTION cortex_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION cortex_forbid_mutation();
CREATE TRIGGER ledger_tx_append_only BEFORE UPDATE OR DELETE ON "LedgerTx" FOR EACH ROW EXECUTE FUNCTION cortex_forbid_mutation();
CREATE TRIGGER ledger_entry_append_only BEFORE UPDATE OR DELETE ON "LedgerEntry" FOR EACH ROW EXECUTE FUNCTION cortex_forbid_mutation();
