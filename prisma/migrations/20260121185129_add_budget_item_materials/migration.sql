-- AlterTable
ALTER TABLE "Budget" ADD COLUMN     "cardFeePercent" DOUBLE PRECISION,
ADD COLUMN     "dailyRateCents" INTEGER,
ADD COLUMN     "deliveryDays" INTEGER,
ADD COLUMN     "discountPercent" DOUBLE PRECISION,
ADD COLUMN     "discountType" TEXT;
