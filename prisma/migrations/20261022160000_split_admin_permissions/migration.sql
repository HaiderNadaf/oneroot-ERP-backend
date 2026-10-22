-- The administration pages are now View / Add / Edit / Delete too: whoever could manage a page
-- (admin.users, admin.roles...) keeps adding and editing there, now as separate ticks
CREATE TEMP TABLE admin_grant (has_key TEXT NOT NULL, add_key TEXT NOT NULL);
INSERT INTO admin_grant (has_key, add_key) VALUES
  ('admin.users', 'users.create'),
  ('admin.users', 'users.edit'),
  ('admin.roles', 'roles.create'),
  ('admin.roles', 'roles.edit'),
  ('admin.roles', 'roles.delete'),
  ('admin.schemes', 'schemes.create'),
  ('admin.schemes', 'schemes.edit'),
  ('admin.schemes', 'schemes.delete'),
  ('admin.branches', 'branches.create'),
  ('admin.branches', 'branches.edit'),
  ('admin.settings', 'settings.edit'),
  ('admin.approval_rules', 'approval_rules.edit');

UPDATE "RoleTemplate" r SET "permissions" = (
  SELECT array_agg(DISTINCT k) FROM (
    SELECT unnest(r."permissions") AS k
    UNION SELECT g.add_key FROM admin_grant g WHERE g.has_key = ANY(r."permissions")
  ) x
)
WHERE r."permissions" && (SELECT array_agg(has_key) FROM admin_grant);

UPDATE "RolePermission" r SET "permissions" = (
  SELECT array_agg(DISTINCT k) FROM (
    SELECT unnest(r."permissions") AS k
    UNION SELECT g.add_key FROM admin_grant g WHERE g.has_key = ANY(r."permissions")
  ) x
)
WHERE r."permissions" && (SELECT array_agg(has_key) FROM admin_grant);

UPDATE "User" r SET "permissions" = (
  SELECT array_agg(DISTINCT k) FROM (
    SELECT unnest(r."permissions") AS k
    UNION SELECT g.add_key FROM admin_grant g WHERE g.has_key = ANY(r."permissions")
  ) x
)
WHERE r."permissions" && (SELECT array_agg(has_key) FROM admin_grant);

DROP TABLE admin_grant;
