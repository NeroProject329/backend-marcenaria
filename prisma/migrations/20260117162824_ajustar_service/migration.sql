-- AlterTable
ALTER TABLE "Salon" ADD COLUMN     "blockOutsideHours" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "closeTime" TEXT,
ADD COLUMN     "openTime" TEXT,
ADD COLUMN     "workingDays" INTEGER[];
