-- Existing roles take their level from their name: administrators L3, managers and heads L2, the rest stay L1
UPDATE "RoleTemplate" SET "level" = 'L3' WHERE "name" ~* '\madmin(istrator)?\M';
UPDATE "RoleTemplate" SET "level" = 'L2' WHERE "level" = 'L1' AND "name" ~* '\m(manager|head)\M';
