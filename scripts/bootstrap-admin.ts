import "./load-env";
import { closePool, one, pool } from "../src/lib/db";
import { createAdminUser } from "../src/lib/auth/admin-auth";
import { adminPasswordSchema } from "../src/lib/validation";

/**
 * Creates the first Association Administrator on a fresh hosted database, where there is no shell
 * to run `npm run admin:create`. Runs during the Vercel build (scripts/vercel-build.sh).
 *
 * Does nothing unless BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are set, and never
 * touches an existing account. The account must change the password at first login; remove
 * the two variables from the project afterwards.
 */
async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log("No bootstrap administrator configured; skipping.");
    return;
  }
  const exists = await one<{ id: string }>(pool(), `select id from admin_users where authentication_reference = $1`, [email]);
  if (exists) {
    console.log("Bootstrap administrator already exists; skipping.");
    return;
  }
  const parsed = adminPasswordSchema.safeParse(password);
  if (!parsed.success) throw new Error(`BOOTSTRAP_ADMIN_PASSWORD: ${parsed.error.issues[0].message}`);
  const res = await createAdminUser(
    pool(),
    { email, displayName: process.env.BOOTSTRAP_ADMIN_NAME?.trim() || "Association Administrator", role: "union_admin", password: parsed.data, mustChangePassword: true },
    null,
  );
  if (!res.ok) throw new Error("Could not create the bootstrap administrator.");
  // The password is never printed.
  console.log("Created the bootstrap Association Administrator. They must change the password at first login.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
