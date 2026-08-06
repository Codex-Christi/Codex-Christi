ALTER TABLE "PaypalIntent"
ADD COLUMN "canonicalOrderSnapshot" JSONB,
ADD COLUMN "canonicalOrderSnapshotVersion" TEXT,
ADD COLUMN "canonicalOrderSnapshotHash" TEXT;

-- Pre-P0.2 rows remain entirely null. New rows must persist the sealed snapshot and its external
-- version/hash metadata together so a partial envelope cannot be mistaken for a legacy order.
ALTER TABLE "PaypalIntent"
ADD CONSTRAINT "PaypalIntent_canonicalOrderSnapshot_complete" CHECK (
  (
    "canonicalOrderSnapshot" IS NULL
    AND "canonicalOrderSnapshotVersion" IS NULL
    AND "canonicalOrderSnapshotHash" IS NULL
  )
  OR
  (
    "canonicalOrderSnapshot" IS NOT NULL
    AND "canonicalOrderSnapshotVersion" IS NOT NULL
    AND "canonicalOrderSnapshotHash" IS NOT NULL
  )
);
