-- Names admins give devices (browsers), shown in the audit log
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "labelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);
