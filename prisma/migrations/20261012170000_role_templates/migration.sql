-- Custom roles: a named set of permission ticks built on a built-in role
CREATE TABLE "RoleTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseRole" "Role" NOT NULL,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RoleTemplate_name_key" ON "RoleTemplate"("name");

ALTER TABLE "User" ADD COLUMN "roleTemplateId" TEXT;

ALTER TABLE "User" ADD CONSTRAINT "User_roleTemplateId_fkey" FOREIGN KEY ("roleTemplateId") REFERENCES "RoleTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
