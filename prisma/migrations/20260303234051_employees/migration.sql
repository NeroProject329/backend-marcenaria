-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "sector" TEXT,
    "salaryCents" INTEGER NOT NULL DEFAULT 0,
    "benefitsCents" INTEGER NOT NULL DEFAULT 0,
    "payDay" INTEGER NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "payrollRecurringGroupId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Employee_salonId_isActive_idx" ON "Employee"("salonId", "isActive");

-- CreateIndex
CREATE INDEX "Employee_salonId_name_idx" ON "Employee"("salonId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_salonId_payrollRecurringGroupId_key" ON "Employee"("salonId", "payrollRecurringGroupId");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
