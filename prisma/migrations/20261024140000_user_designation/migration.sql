-- Job title shown on the user (separate from the role that gives access)
ALTER TABLE "User" ADD COLUMN "designation" TEXT;
