/*
  Warnings:

  - A unique constraint covering the columns `[salonId,recurringGroupId,yearMonth]` on the table `Cost` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `yearMonth` to the `Cost` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
-- 1) adiciona colunas novas (yearMonth SEM NOT NULL por enquanto)
ALTER TABLE "Cost"
  ADD COLUMN "category" TEXT,
  ADD COLUMN "isRecurring" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "recurringGroupId" TEXT,
  ADD COLUMN "yearMonth" TEXT;

-- 2) preenche yearMonth para registros antigos usando occurredAt
UPDATE "Cost"
SET "yearMonth" = to_char(("occurredAt" AT TIME ZONE 'UTC'), 'YYYY-MM')
WHERE "yearMonth" IS NULL;

-- 3) agora sim trava yearMonth como obrigatório
ALTER TABLE "Cost"
  ALTER COLUMN "yearMonth" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Cost_salonId_yearMonth_idx" ON "Cost"("salonId", "yearMonth");

-- CreateIndex
CREATE INDEX "Cost_salonId_isRecurring_idx" ON "Cost"("salonId", "isRecurring");

-- CreateIndex
CREATE INDEX "Cost_salonId_recurringGroupId_idx" ON "Cost"("salonId", "recurringGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "Cost_salonId_recurringGroupId_yearMonth_key"
ON "Cost"("salonId", "recurringGroupId", "yearMonth");
