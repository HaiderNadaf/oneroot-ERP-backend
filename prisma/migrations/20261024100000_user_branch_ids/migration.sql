-- Users can work in several branches (empty = all branches); the home branch stays in "branchId"
ALTER TABLE "User" ADD COLUMN "branchIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Existing users keep exactly their current access: their one home branch, or all branches
UPDATE "User" SET "branchIds" = ARRAY["branchId"] WHERE "branchId" IS NOT NULL;
