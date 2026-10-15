-- Agents: ORAGENT00001-style code, soft delete with the user who deleted
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Agent_agentId_key" ON "Agent"("agentId");
CREATE INDEX "Agent_deletedAt_idx" ON "Agent"("deletedAt");

ALTER TABLE "Agent" ADD CONSTRAINT "Agent_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
