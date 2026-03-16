-- AlterTable
ALTER TABLE "Budget" ADD COLUMN     "cashTotalCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "grossTotalCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "installmentAmountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "installmentTotalCents" INTEGER NOT NULL DEFAULT 0;
