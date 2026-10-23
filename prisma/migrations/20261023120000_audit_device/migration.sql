-- Audit log: which device each action came from
ALTER TABLE "AuditLog" ADD COLUMN "deviceId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "deviceName" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "ipAddress" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "userAgent" TEXT;

CREATE INDEX "AuditLog_deviceId_idx" ON "AuditLog"("deviceId");
