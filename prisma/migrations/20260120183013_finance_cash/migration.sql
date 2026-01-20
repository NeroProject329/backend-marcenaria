/*
  Warnings:

  - A unique constraint covering the columns `[approvedOrderId]` on the table `Budget` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Budget_approvedOrderId_key" ON "Budget"("approvedOrderId");
