/*
  Warnings:

  - You are about to drop the column `userId` on the `Salon` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[ownerId]` on the table `Salon` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `ownerId` to the `Salon` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Salon" DROP CONSTRAINT "Salon_userId_fkey";

-- DropIndex
DROP INDEX "Salon_userId_key";

-- AlterTable
ALTER TABLE "Salon" DROP COLUMN "userId",
ADD COLUMN     "address" TEXT,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "ownerId" TEXT NOT NULL,
ADD COLUMN     "phone" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Salon_ownerId_key" ON "Salon"("ownerId");

-- AddForeignKey
ALTER TABLE "Salon" ADD CONSTRAINT "Salon_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
