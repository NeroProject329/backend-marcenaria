/*
  Warnings:

  - Added the required column `updatedAt` to the `MaterialMovement` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "MaterialMovement_materialId_idx";

-- DropIndex
DROP INDEX "MaterialMovement_supplierId_idx";


-- AlterTable
ALTER TABLE "MaterialMovement"
ADD COLUMN "payableId" TEXT,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW();

-- CreateIndex
CREATE INDEX "MaterialMovement_materialId_occurredAt_idx" ON "MaterialMovement"("materialId", "occurredAt");

-- CreateIndex
CREATE INDEX "MaterialMovement_supplierId_occurredAt_idx" ON "MaterialMovement"("supplierId", "occurredAt");

-- CreateIndex
CREATE INDEX "MaterialMovement_payableId_idx" ON "MaterialMovement"("payableId");

-- AddForeignKey
ALTER TABLE "MaterialMovement" ADD CONSTRAINT "MaterialMovement_payableId_fkey" FOREIGN KEY ("payableId") REFERENCES "Payable"("id") ON DELETE SET NULL ON UPDATE CASCADE;
