-- Seniority of a role inside its department; every existing role starts at L1
CREATE TYPE "RoleLevel" AS ENUM ('L1', 'L2', 'L3');

ALTER TABLE "RoleTemplate" ADD COLUMN "level" "RoleLevel" NOT NULL DEFAULT 'L1';
