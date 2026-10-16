import { execFileSync } from "node:child_process";

/** Rebuild the disposable test database schema once per test run. */
export default function setup() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/test/i.test(url)) throw new Error(`Refusing to reset a non-test database: ${url.replace(/\/\/.*@/, "//***@")}`);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts", "--reset"], { stdio: "inherit", env: process.env });
}
