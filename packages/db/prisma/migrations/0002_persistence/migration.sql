-- Idempotent persistence (live + shadow): every row a worker writes has a deterministic key, so a
-- record replayed after a crash (or by the backfill CLI) is written once. See postgres-sink.ts.

-- Events: deterministic key. On a hypertable a unique index must include the time column.
ALTER TABLE "events" ADD COLUMN "key" TEXT;
CREATE UNIQUE INDEX "events_key_ts_key" ON "events"("key", "ts");

-- Ledger postings: position inside the transaction (existing rows numbered in insertion order).
ALTER TABLE "LedgerEntry" ADD COLUMN "idx" INTEGER;
UPDATE "LedgerEntry" e SET "idx" = r.n
  FROM (SELECT "id", (ROW_NUMBER() OVER (PARTITION BY "txId" ORDER BY "id") - 1)::INTEGER AS n FROM "LedgerEntry") r
  WHERE e."id" = r."id";
ALTER TABLE "LedgerEntry" ALTER COLUMN "idx" SET NOT NULL;
CREATE UNIQUE INDEX "LedgerEntry_txId_idx_key" ON "LedgerEntry"("txId", "idx");

-- Withdrawals: the trading process never knows the network (and may not know the address).
ALTER TABLE "Withdrawal" ALTER COLUMN "network" DROP NOT NULL;
ALTER TABLE "Withdrawal" ALTER COLUMN "address" DROP NOT NULL;

-- Durable persistence cursor per bot run.
CREATE TABLE "PersistCursor" (
    "botId" TEXT NOT NULL,
    "run" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PersistCursor_pkey" PRIMARY KEY ("botId","run")
);
