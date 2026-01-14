-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('AVISTA', 'PARCELADO');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "firstDueDate" TIMESTAMP(3),
ADD COLUMN     "installmentsCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "paymentMethod" "PaymentMethod",
ADD COLUMN     "paymentMode" "PaymentMode" NOT NULL DEFAULT 'AVISTA';
