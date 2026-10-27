ALTER TABLE "Material"
ADD COLUMN "saleMarginPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "salePriceCents" INTEGER NOT NULL DEFAULT 0;

UPDATE "Material"
SET "salePriceCents" = "defaultUnitCostCents"
WHERE "salePriceCents" = 0;
