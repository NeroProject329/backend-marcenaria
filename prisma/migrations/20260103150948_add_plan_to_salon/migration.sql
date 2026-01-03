-- AlterTable
ALTER TABLE "Salon" ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'FREE',
ADD COLUMN     "planEndsAt" TIMESTAMP(3),
ADD COLUMN     "planStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Salon_plan_planStatus_idx" ON "Salon"("plan", "planStatus");
