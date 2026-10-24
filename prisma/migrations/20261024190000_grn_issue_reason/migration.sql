-- Why goods on a GRN line were not accepted (damaged, leakage, expired, quality, other) and what was wrong
ALTER TABLE "GrnItem" ADD COLUMN "issueReason" TEXT, ADD COLUMN "issueRemark" TEXT;
