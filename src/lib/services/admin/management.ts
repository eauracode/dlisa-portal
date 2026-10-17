import { one, rows, withTransaction, type Db } from "../../db";
import { audit } from "../../audit";
import { assertCan } from "../../auth/permissions";
import { createAdminUser } from "../../auth/admin-auth";
import { destroyAllSessionsFor } from "../../auth/sessions";
import type { AdminRole } from "../../validation";
import { ActionError, NotFoundError, type AdminContext } from "./context";

export async function listAdmins(db: Db, admin: AdminContext) {
  assertCan(admin.role, "admins.manage");
  return rows<{ id: string; authentication_reference: string; display_name: string; role: AdminRole; active: boolean; last_login_at: Date | null; created_at: Date; must_change_password: boolean }>(
    db,
    `select id, authentication_reference, display_name, role, active, last_login_at, created_at, must_change_password
       from admin_users order by active desc, role, display_name`,
  );
}

export async function createAdmin(admin: AdminContext, input: { email: string; displayName: string; role: AdminRole; password: string }) {
  assertCan(admin.role, "admins.manage");
  return withTransaction(async (tx) => {
    const res = await createAdminUser(tx, { ...input, mustChangePassword: true }, admin.id);
    if (!res.ok) throw new ActionError("An administrator with this email already exists.");
    return res.id;
  });
}

export async function updateAdmin(admin: AdminContext, targetId: string, input: { role: AdminRole; active: boolean }) {
  assertCan(admin.role, "admins.manage");
  return withTransaction(async (tx) => {
    // Serialise role changes so two admins cannot demote each other simultaneously.
    await tx.query(`select pg_advisory_xact_lock(hashtext('dli:admin-roles'))`);
    const target = await one<{ id: string; role: AdminRole; active: boolean }>(tx, `select id, role, active from admin_users where id = $1 for update`, [targetId]);
    if (!target) throw new NotFoundError("Administrator");
    const losingAdmin = target.role === "union_admin" && target.active && (input.role !== "union_admin" || !input.active);
    if (losingAdmin) {
      const others = await one<{ n: number }>(tx, `select count(*)::int as n from admin_users where role = 'union_admin' and active and id <> $1`, [targetId]);
      if (!others?.n) throw new ActionError("At least one active Association Administrator must remain.");
    }
    await tx.query(`update admin_users set role = $2, active = $3, updated_at = now() where id = $1`, [targetId, input.role, input.active]);
    if (!input.active || input.role !== target.role) await destroyAllSessionsFor(tx, { type: "admin", adminId: targetId });
    if (!input.active) await tx.query(`update consolidated_issues set assigned_admin_id = null where assigned_admin_id = $1`, [targetId]);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "admin.updated", entityType: "admin_user", entityId: targetId, metadata: { role: input.role, active: input.active } });
  });
}

export async function listAllCategories(db: Db) {
  return rows<{ id: number; slug: string; name: string; description: string; academic: boolean; active: boolean; sort_order: number; complaint_count: number }>(
    db,
    `select cat.id, cat.slug, cat.name, cat.description, cat.academic, cat.active, cat.sort_order,
            (select count(*)::int from complaints c where c.category_id = cat.id) as complaint_count
       from issue_categories cat order by cat.sort_order, cat.name`,
  );
}

export async function saveCategory(admin: AdminContext, input: { id?: number; name: string; description: string; academic: boolean; active: boolean; sortOrder: number }) {
  assertCan(admin.role, "settings.manage");
  const name = input.name.trim();
  if (name.length < 3 || name.length > 80) throw new ActionError("Category names must be 3–80 characters.");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return withTransaction(async (tx) => {
    try {
      if (input.id) {
        // The slug is kept stable once created (the classifier refers to it).
        await tx.query(
          `update issue_categories set name = $2, description = $3, academic = $4, active = $5, sort_order = $6 where id = $1`,
          [input.id, name, input.description.trim().slice(0, 300), input.academic, input.active, input.sortOrder],
        );
      } else {
        await tx.query(
          `insert into issue_categories (slug, name, description, academic, active, sort_order) values ($1, $2, $3, $4, $5, $6)`,
          [slug, name, input.description.trim().slice(0, 300), input.academic, input.active, input.sortOrder],
        );
      }
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ActionError("A category with this name already exists.");
      throw err;
    }
    await audit(tx, { actorType: "admin", actorId: admin.id, action: input.id ? "category.updated" : "category.created", entityType: "issue_category", entityId: String(input.id ?? slug), metadata: { name, active: input.active } });
  });
}
