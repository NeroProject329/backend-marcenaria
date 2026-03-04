-- CreateEnum
CREATE TYPE "SaasBillingProvider" AS ENUM ('ABACATEPAY');

-- CreateEnum
CREATE TYPE "SaasBillingStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED');

-- AlterTable
ALTER TABLE "Salon" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "planOverrideEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "planOverrideEndsAt" TIMESTAMP(3),
ADD COLUMN     "planOverridePlan" TEXT,
ADD COLUMN     "planOverrideReason" TEXT;

-- CreateTable
CREATE TABLE "SaasBilling" (
    "id" TEXT NOT NULL,
    "provider" "SaasBillingProvider" NOT NULL DEFAULT 'ABACATEPAY',
    "status" "SaasBillingStatus" NOT NULL DEFAULT 'PENDING',
    "salonId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "periodDays" INTEGER NOT NULL DEFAULT 30,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "providerBillingId" TEXT,
    "providerCheckoutUrl" TEXT,
    "providerCustomerId" TEXT,
    "providerDevMode" BOOLEAN NOT NULL DEFAULT false,
    "externalId" TEXT,
    "metadataJson" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidAmountCents" INTEGER,
    "feeCents" INTEGER,
    "paidMethod" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaasBilling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" "SaasBillingProvider" NOT NULL DEFAULT 'ABACATEPAY',
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "devMode" BOOLEAN NOT NULL DEFAULT false,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "providerBillingId" TEXT,
    "saasBillingId" TEXT,
    "salonId" TEXT,
    "rawBody" TEXT NOT NULL,
    "headersJson" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminActionLog" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetSalonId" TEXT,
    "detailsJson" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaasBilling_providerBillingId_key" ON "SaasBilling"("providerBillingId");

-- CreateIndex
CREATE UNIQUE INDEX "SaasBilling_externalId_key" ON "SaasBilling"("externalId");

-- CreateIndex
CREATE INDEX "SaasBilling_salonId_createdAt_idx" ON "SaasBilling"("salonId", "createdAt");

-- CreateIndex
CREATE INDEX "SaasBilling_salonId_status_idx" ON "SaasBilling"("salonId", "status");

-- CreateIndex
CREATE INDEX "SaasBilling_providerBillingId_idx" ON "SaasBilling"("providerBillingId");

-- CreateIndex
CREATE INDEX "SaasBilling_externalId_idx" ON "SaasBilling"("externalId");

-- CreateIndex
CREATE INDEX "WebhookEvent_eventType_idx" ON "WebhookEvent"("eventType");

-- CreateIndex
CREATE INDEX "WebhookEvent_providerBillingId_idx" ON "WebhookEvent"("providerBillingId");

-- CreateIndex
CREATE INDEX "WebhookEvent_salonId_receivedAt_idx" ON "WebhookEvent"("salonId", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_idx" ON "WebhookEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE INDEX "AdminUser_isActive_idx" ON "AdminUser"("isActive");

-- CreateIndex
CREATE INDEX "AdminActionLog_adminUserId_createdAt_idx" ON "AdminActionLog"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminActionLog_targetSalonId_createdAt_idx" ON "AdminActionLog"("targetSalonId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminActionLog_action_idx" ON "AdminActionLog"("action");

-- CreateIndex
CREATE INDEX "Salon_planEndsAt_idx" ON "Salon"("planEndsAt");

-- CreateIndex
CREATE INDEX "Salon_cancelAtPeriodEnd_planEndsAt_idx" ON "Salon"("cancelAtPeriodEnd", "planEndsAt");

-- CreateIndex
CREATE INDEX "Salon_planOverrideEnabled_planOverrideEndsAt_idx" ON "Salon"("planOverrideEnabled", "planOverrideEndsAt");

-- AddForeignKey
ALTER TABLE "SaasBilling" ADD CONSTRAINT "SaasBilling_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_saasBillingId_fkey" FOREIGN KEY ("saasBillingId") REFERENCES "SaasBilling"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminActionLog" ADD CONSTRAINT "AdminActionLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminActionLog" ADD CONSTRAINT "AdminActionLog_targetSalonId_fkey" FOREIGN KEY ("targetSalonId") REFERENCES "Salon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
