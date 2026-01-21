-- CreateEnum
CREATE TYPE "MaterialUnit" AS ENUM ('UN', 'M', 'M2', 'M3', 'L', 'KG', 'CX', 'OUTRO');

-- CreateEnum
CREATE TYPE "MaterialMovementType" AS ENUM ('IN', 'OUT', 'ADJUST');

-- CreateEnum
CREATE TYPE "MaterialMovementSource" AS ENUM ('MANUAL', 'ORDER', 'PURCHASE');

-- AlterTable
ALTER TABLE "BudgetItemMaterial" ADD COLUMN     "materialId" TEXT;

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" "MaterialUnit" NOT NULL DEFAULT 'UN',
    "defaultUnitCostCents" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialMovement" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "type" "MaterialMovementType" NOT NULL,
    "source" "MaterialMovementSource" NOT NULL DEFAULT 'MANUAL',
    "qty" DOUBLE PRECISION NOT NULL,
    "unitCostCents" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Material_salonId_isActive_idx" ON "Material"("salonId", "isActive");

-- CreateIndex
CREATE INDEX "Material_salonId_name_idx" ON "Material"("salonId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Material_salonId_name_key" ON "Material"("salonId", "name");

-- CreateIndex
CREATE INDEX "MaterialMovement_salonId_occurredAt_idx" ON "MaterialMovement"("salonId", "occurredAt");

-- CreateIndex
CREATE INDEX "MaterialMovement_salonId_type_idx" ON "MaterialMovement"("salonId", "type");

-- CreateIndex
CREATE INDEX "MaterialMovement_materialId_idx" ON "MaterialMovement"("materialId");

-- CreateIndex
CREATE INDEX "MaterialMovement_orderId_idx" ON "MaterialMovement"("orderId");

-- CreateIndex
CREATE INDEX "BudgetItemMaterial_materialId_idx" ON "BudgetItemMaterial"("materialId");

-- AddForeignKey
ALTER TABLE "BudgetItemMaterial" ADD CONSTRAINT "BudgetItemMaterial_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialMovement" ADD CONSTRAINT "MaterialMovement_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialMovement" ADD CONSTRAINT "MaterialMovement_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialMovement" ADD CONSTRAINT "MaterialMovement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
