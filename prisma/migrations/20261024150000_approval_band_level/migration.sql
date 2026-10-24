-- Highest role level ticked for a value band (L2 includes L1, L3 includes L1 and L2); null = none ticked
ALTER TABLE "ApprovalBand" ADD COLUMN "level" "RoleLevel";
