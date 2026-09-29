-- Accounts given a temporary password (by an administrator, or by the desktop's local recovery)
-- must choose their own before the API serves anything else.
ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
