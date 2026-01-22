-- CreateTable
CREATE TABLE "MaterialSupplierPrice" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "unitCostCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialSupplierPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaterialSupplierPrice_supplierId_idx" ON "MaterialSupplierPrice"("supplierId");

-- CreateIndex
CREATE INDEX "MaterialSupplierPrice_materialId_idx" ON "MaterialSupplierPrice"("materialId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialSupplierPrice_materialId_supplierId_key" ON "MaterialSupplierPrice"("materialId", "supplierId");

-- AddForeignKey
ALTER TABLE "MaterialSupplierPrice" ADD CONSTRAINT "MaterialSupplierPrice_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialSupplierPrice" ADD CONSTRAINT "MaterialSupplierPrice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
