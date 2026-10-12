-- Counter write-offs: cashiers and accountants may record stock adjustments; the role limit still forces an approver above it
UPDATE "User" SET "permissions" = array_append("permissions", 'inventory.adjust')
WHERE "role" IN ('CASHIER', 'ACCOUNTANT') AND NOT ('inventory.adjust' = ANY("permissions"));
