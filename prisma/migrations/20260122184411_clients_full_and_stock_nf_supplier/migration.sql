-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "bairro" TEXT,
ADD COLUMN     "cep" TEXT,
ADD COLUMN     "cidade" TEXT,
ADD COLUMN     "complemento" TEXT,
ADD COLUMN     "cpf" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "estado" TEXT,
ADD COLUMN     "logradouro" TEXT,
ADD COLUMN     "numero" TEXT;

-- AlterTable
ALTER TABLE "MaterialMovement" ADD COLUMN     "nfNumber" TEXT,
ADD COLUMN     "supplierId" TEXT;

-- CreateIndex
CREATE INDEX "Client_salonId_name_idx" ON "Client"("salonId", "name");

-- CreateIndex
CREATE INDEX "Client_cpf_idx" ON "Client"("cpf");

-- CreateIndex
CREATE INDEX "Client_email_idx" ON "Client"("email");

-- CreateIndex
CREATE INDEX "MaterialMovement_supplierId_idx" ON "MaterialMovement"("supplierId");

-- CreateIndex
CREATE INDEX "MaterialMovement_nfNumber_idx" ON "MaterialMovement"("nfNumber");

-- AddForeignKey
ALTER TABLE "MaterialMovement" ADD CONSTRAINT "MaterialMovement_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
