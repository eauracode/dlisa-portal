import "./load-env";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { closePool, pool } from "../src/lib/db";

/**
 * Applies db/migrations/*.sql in filename order, each in its own transaction, recording
 * applied files in schema_migrations. Safe to run repeatedly.
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --reset DROP and recreate the public schema first (dev/test only)
 */
async function main() {
  const reset = process.argv.includes("--reset");
  const db = pool();
  if (reset) {
    if (process.env.NODE_ENV === "production") throw new Error("--reset is not allowed in production");
    await db.query("drop schema public cascade; create schema public;");
    console.log("Schema reset.");
  }
  await db.query(`create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())`);
  await db.query(`alter table schema_migrations enable row level security`);
  const dir = path.join(process.cwd(), "db", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await db.query<{ filename: string }>(`select filename from schema_migrations`)).rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(`insert into schema_migrations (filename) values ($1)`, [file]);
      await client.query("commit");
      console.log(`Applied ${file}`);
    } catch (err) {
      await client.query("rollback");
      console.error(`Failed to apply ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }
  console.log("Migrations up to date.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
