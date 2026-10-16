import { one, type Db } from "../db";
import { audit } from "../audit";
import { getDummyHash, hashSecret, sleep, verifySecret } from "../security/crypto";
import type { AdminRole } from "../validation";

export interface AdminUser {
  id: string;
  display_name: string;
  role: AdminRole;
  authentication_reference: string;
  must_change_password: boolean;
  active: boolean;
}

export type AdminLoginResult =
  | { ok: true; admin: AdminUser }
  | { ok: false; error: "invalid" }
  | { ok: false; error: "locked"; retryAfterMinutes: number };

const MAX_FAILURES = 5;
const LOCK_MINUTES = 30;

export async function authenticateAdmin(db: Db, email: string, password: string): Promise<AdminLoginResult> {
  const row = await one<AdminUser & { password_hash: string; locked_until: Date | null }>(
    db,
    `select id, display_name, role, authentication_reference, must_change_password, active, password_hash, locked_until
       from admin_users where authentication_reference = $1`,
    [email.trim().toLowerCase()],
  );
  if (!row || !row.active) {
    await verifySecret(password, await getDummyHash());
    await sleep(400);
    return { ok: false, error: "invalid" };
  }
  if (row.locked_until && row.locked_until > new Date()) {
    await sleep(400);
    return { ok: false, error: "locked", retryAfterMinutes: Math.ceil((row.locked_until.getTime() - Date.now()) / 60000) };
  }
  if (await verifySecret(password, row.password_hash)) {
    await db.query(
      `update admin_users set failed_login_attempts = 0, locked_until = null, last_login_at = now() where id = $1`,
      [row.id],
    );
    await audit(db, { actorType: "admin", actorId: row.id, action: "admin.login", entityType: "admin_user", entityId: row.id });
    const admin: AdminUser = {
      id: row.id,
      display_name: row.display_name,
      role: row.role,
      authentication_reference: row.authentication_reference,
      must_change_password: row.must_change_password,
      active: row.active,
    };
    return { ok: true, admin };
  }
  await db.query(
    `update admin_users
        set failed_login_attempts = case when failed_login_attempts + 1 >= $2 then 0 else failed_login_attempts + 1 end,
            locked_until = case when failed_login_attempts + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end
      where id = $1`,
    [row.id, MAX_FAILURES, LOCK_MINUTES],
  );
  await audit(db, { actorType: "system", action: "admin.login_failed", entityType: "admin_user", entityId: row.id });
  await sleep(400);
  return { ok: false, error: "invalid" };
}

export async function getAdminById(db: Db, id: string): Promise<AdminUser | null> {
  return one<AdminUser>(
    db,
    `select id, display_name, role, authentication_reference, must_change_password, active
       from admin_users where id = $1 and active`,
    [id],
  );
}

export async function createAdminUser(
  db: Db,
  input: { email: string; displayName: string; role: AdminRole; password: string; mustChangePassword: boolean },
  createdBy: string | null,
): Promise<{ ok: true; id: string } | { ok: false; error: "exists" }> {
  const row = await one<{ id: string }>(
    db,
    `insert into admin_users (authentication_reference, display_name, role, password_hash, must_change_password)
     values ($1, $2, $3, $4, $5)
     on conflict (authentication_reference) do nothing
     returning id`,
    [input.email.trim().toLowerCase(), input.displayName.trim(), input.role, await hashSecret(input.password), input.mustChangePassword],
  );
  if (!row) return { ok: false, error: "exists" };
  await audit(db, {
    actorType: createdBy ? "admin" : "system",
    actorId: createdBy,
    action: "admin.created",
    entityType: "admin_user",
    entityId: row.id,
    metadata: { role: input.role },
  });
  return { ok: true, id: row.id };
}

export async function setAdminPassword(db: Db, adminId: string, password: string) {
  await db.query(
    `update admin_users set password_hash = $2, must_change_password = false, updated_at = now() where id = $1`,
    [adminId, await hashSecret(password)],
  );
  await audit(db, { actorType: "admin", actorId: adminId, action: "admin.password_changed", entityType: "admin_user", entityId: adminId });
}

export async function verifyAdminPassword(db: Db, adminId: string, password: string): Promise<boolean> {
  const row = await one<{ password_hash: string }>(db, `select password_hash from admin_users where id = $1`, [adminId]);
  return !!row && verifySecret(password, row.password_hash);
}
