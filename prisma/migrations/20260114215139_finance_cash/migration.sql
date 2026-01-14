/*
  Warnings:

  - The values [AUTO_APPOINTMENT] on the enum `CashSource` will be removed. If these variants are still used in the database, this will fail.
  - The values [IN,OUT] on the enum `CashType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `amountCents` on the `CashTransaction` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `CashTransaction` table. All the data in the column will be lost.
  - You are about to drop the column `notes` on the `CashTransaction` table. All the data in the column will be lost.
  - You are about to drop the column `address` on the `Salon` table. All the data in the column will be lost.
  - You are about to drop the column `blockOutsideHours` on the `Salon` table. All the data in the column will be lost.
  - You are about to drop the column `closeTime` on the `Salon` table. All the data in the column will be lost.
  - You are about to drop the column `logoUrl` on the `Salon` table. All the data in the column will be lost.
  - You are about to drop the column `openTime` on the `Salon` table. All the data in the column will be lost.
  - You are about to drop the column `ownerId` on the `Salon` table. All the data in the column will be lost.
  - You are about to drop the column `phone` on the `Salon` table. All the data in the column will be lost.
  - You are about to drop the column `trialEndsAt` on the `Salon` table. All the data in the column will be lost.
  - You are about to drop the column `workingDays` on the `Salon` table. All the data in the column will be lost.
  - You are about to drop the column `durationM` on the `Service` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[salonId,name,type]` on the table `CashCategory` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId]` on the table `Salon` will be added. If there are existing duplicate values, this will fail.
  - Made the column `type` on table `CashCategory` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `amount` to the `CashTransaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `CashTransaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `Salon` table without a default value. This is not possible if the table is not empty.
  - Added the required column `duration` to the `Service` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ClientType" AS ENUM ('CLIENTE', 'FORNECEDOR', 'BOTH');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('ORCAMENTO', 'PEDIDO', 'EM_PRODUCAO', 'PRONTO', 'ENTREGUE', 'CANCELADO');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDENTE', 'EM_ROTA', 'ENTREGUE', 'ATRASADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "InstallmentStatus" AS ENUM ('PENDENTE', 'PAGO', 'ATRASADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "CostType" AS ENUM ('FIXO', 'VARIAVEL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PIX', 'CARTAO', 'DINHEIRO', 'BOLETO', 'TRANSFERENCIA', 'OUTRO');

-- AlterEnum
BEGIN;
CREATE TYPE "CashSource_new" AS ENUM ('MANUAL', 'APPOINTMENT');
ALTER TABLE "public"."CashTransaction" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "CashTransaction" ALTER COLUMN "source" TYPE "CashSource_new" USING ("source"::text::"CashSource_new");
ALTER TYPE "CashSource" RENAME TO "CashSource_old";
ALTER TYPE "CashSource_new" RENAME TO "CashSource";
DROP TYPE "public"."CashSource_old";
ALTER TABLE "CashTransaction" ALTER COLUMN "source" SET DEFAULT 'MANUAL';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "CashType_new" AS ENUM ('INCOME', 'EXPENSE');
ALTER TABLE "CashCategory" ALTER COLUMN "type" TYPE "CashType_new" USING ("type"::text::"CashType_new");
ALTER TABLE "CashTransaction" ALTER COLUMN "type" TYPE "CashType_new" USING ("type"::text::"CashType_new");
ALTER TYPE "CashType" RENAME TO "CashType_old";
ALTER TYPE "CashType_new" RENAME TO "CashType";
DROP TYPE "public"."CashType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Salon" DROP CONSTRAINT "Salon_ownerId_fkey";

-- DropIndex
DROP INDEX "CashCategory_salonId_idx";

-- DropIndex
DROP INDEX "CashCategory_salonId_name_key";

-- DropIndex
DROP INDEX "Salon_ownerId_key";

-- AlterTable
ALTER TABLE "Appointment" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED';

-- AlterTable
ALTER TABLE "CashCategory" ALTER COLUMN "type" SET NOT NULL;

-- AlterTable
ALTER TABLE "CashTransaction" DROP COLUMN "amountCents",
DROP COLUMN "name",
DROP COLUMN "notes",
ADD COLUMN     "amount" INTEGER NOT NULL,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "type" "ClientType" NOT NULL DEFAULT 'CLIENTE';

-- AlterTable
ALTER TABLE "Salon" DROP COLUMN "address",
DROP COLUMN "blockOutsideHours",
DROP COLUMN "closeTime",
DROP COLUMN "logoUrl",
DROP COLUMN "openTime",
DROP COLUMN "ownerId",
DROP COLUMN "phone",
DROP COLUMN "trialEndsAt",
DROP COLUMN "workingDays",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Service" DROP COLUMN "durationM",
ADD COLUMN     "duration" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'ORCAMENTO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clientId" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "expectedDeliveryAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDENTE',
    "expectedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "address" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receivable" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "method" "PaymentMethod",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Receivable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivableInstallment" (
    "id" TEXT NOT NULL,
    "receivableId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "InstallmentStatus" NOT NULL DEFAULT 'PENDENTE',
    "paidAt" TIMESTAMP(3),
    "method" "PaymentMethod",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivableInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payable" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT,
    "salonId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayableInstallment" (
    "id" TEXT NOT NULL,
    "payableId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "InstallmentStatus" NOT NULL DEFAULT 'PENDENTE',
    "paidAt" TIMESTAMP(3),
    "method" "PaymentMethod",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayableInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cost" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "type" "CostType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "amountCents" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "supplierId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_salonId_createdAt_idx" ON "Order"("salonId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_salonId_status_idx" ON "Order"("salonId", "status");

-- CreateIndex
CREATE INDEX "Order_clientId_idx" ON "Order"("clientId");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "Delivery_orderId_idx" ON "Delivery"("orderId");

-- CreateIndex
CREATE INDEX "Delivery_status_idx" ON "Delivery"("status");

-- CreateIndex
CREATE INDEX "Receivable_salonId_createdAt_idx" ON "Receivable"("salonId", "createdAt");

-- CreateIndex
CREATE INDEX "Receivable_orderId_idx" ON "Receivable"("orderId");

-- CreateIndex
CREATE INDEX "ReceivableInstallment_receivableId_idx" ON "ReceivableInstallment"("receivableId");

-- CreateIndex
CREATE INDEX "ReceivableInstallment_dueDate_idx" ON "ReceivableInstallment"("dueDate");

-- CreateIndex
CREATE INDEX "ReceivableInstallment_status_idx" ON "ReceivableInstallment"("status");

-- CreateIndex
CREATE INDEX "Payable_salonId_createdAt_idx" ON "Payable"("salonId", "createdAt");

-- CreateIndex
CREATE INDEX "Payable_supplierId_idx" ON "Payable"("supplierId");

-- CreateIndex
CREATE INDEX "PayableInstallment_payableId_idx" ON "PayableInstallment"("payableId");

-- CreateIndex
CREATE INDEX "PayableInstallment_dueDate_idx" ON "PayableInstallment"("dueDate");

-- CreateIndex
CREATE INDEX "PayableInstallment_status_idx" ON "PayableInstallment"("status");

-- CreateIndex
CREATE INDEX "Cost_salonId_occurredAt_idx" ON "Cost"("salonId", "occurredAt");

-- CreateIndex
CREATE INDEX "Cost_salonId_type_idx" ON "Cost"("salonId", "type");

-- CreateIndex
CREATE INDEX "Cost_supplierId_idx" ON "Cost"("supplierId");

-- CreateIndex
CREATE INDEX "CashCategory_salonId_type_idx" ON "CashCategory"("salonId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "CashCategory_salonId_name_type_key" ON "CashCategory"("salonId", "name", "type");

-- CreateIndex
CREATE INDEX "Client_salonId_type_idx" ON "Client"("salonId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Salon_userId_key" ON "Salon"("userId");

-- AddForeignKey
ALTER TABLE "Salon" ADD CONSTRAINT "Salon_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivableInstallment" ADD CONSTRAINT "ReceivableInstallment_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "Receivable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payable" ADD CONSTRAINT "Payable_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payable" ADD CONSTRAINT "Payable_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayableInstallment" ADD CONSTRAINT "PayableInstallment_payableId_fkey" FOREIGN KEY ("payableId") REFERENCES "Payable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cost" ADD CONSTRAINT "Cost_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cost" ADD CONSTRAINT "Cost_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
