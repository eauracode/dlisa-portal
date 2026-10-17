import "./load-env";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { closePool, pool } from "../src/lib/db";
import { createAdminUser } from "../src/lib/auth/admin-auth";
import { adminPasswordSchema, ADMIN_ROLES, type AdminRole } from "../src/lib/validation";

/**
 * Secure provisioning of administrator accounts (there are no default credentials).
 *
 *   npm run admin:create -- --email chair@example.org --name "Association Chair" --role union_admin
 *
 * The password is read from the ADMIN_PASSWORD environment variable or prompted for, so
 * it never appears in shell history. The account must change it at first login.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      role: { type: "string", default: "union_admin" },
    },
  });
  if (!values.email || !values.name) throw new Error("Usage: --email <email> --name <display name> [--role union_admin|case_officer|oversight_officer]");
  if (!ADMIN_ROLES.includes(values.role as AdminRole)) throw new Error(`Role must be one of: ${ADMIN_ROLES.join(", ")}`);

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    const rl = createInterface({ input: stdin, output: stdout });
    password = await rl.question("Initial password (min 12 chars, letters and numbers): ");
    rl.close();
  }
  const parsed = adminPasswordSchema.safeParse(password);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const res = await createAdminUser(
    pool(),
    { email: values.email, displayName: values.name, role: values.role as AdminRole, password: parsed.data, mustChangePassword: true },
    null,
  );
  if (!res.ok) throw new Error("An administrator with that email already exists.");
  console.log(`Created ${values.role} ${values.email}. They will be asked to change the password at first login.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
