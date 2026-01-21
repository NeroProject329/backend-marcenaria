-- CreateTable
CREATE TABLE "BudgetItemMaterial" (
    "id" TEXT NOT NULL,
    "budgetItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unitCostCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderItemId" TEXT,

    CONSTRAINT "BudgetItemMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BudgetItemMaterial_budgetItemId_idx" ON "BudgetItemMaterial"("budgetItemId");

-- CreateIndex
CREATE INDEX "BudgetItemMaterial_name_idx" ON "BudgetItemMaterial"("name");

-- AddForeignKey
ALTER TABLE "BudgetItemMaterial" ADD CONSTRAINT "BudgetItemMaterial_budgetItemId_fkey" FOREIGN KEY ("budgetItemId") REFERENCES "BudgetItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetItemMaterial" ADD CONSTRAINT "BudgetItemMaterial_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
