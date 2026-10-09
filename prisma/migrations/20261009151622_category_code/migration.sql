-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "code" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Category_code_key" ON "Category"("code");

