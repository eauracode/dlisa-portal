// Starts/stops a self-contained development PostgreSQL cluster in ./.pgdata (port 5433),
// so local development needs no credentials for a system-wide PostgreSQL install.
//   npm run local-db:start   (creates the cluster and databases on first run)
//   npm run local-db:stop
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const PORT = process.env.LOCAL_PG_PORT ?? "5433";
const DATA = path.resolve(".pgdata");
const bin = (name) => {
  const dir = process.env.PG_BIN ?? (process.platform === "win32" ? "C:/Program Files/PostgreSQL/17/bin" : "");
  return dir ? path.join(dir, process.platform === "win32" ? `${name}.exe` : name) : name;
};
const run = (name, args) => execFileSync(bin(name), args, { stdio: "inherit" });

const command = process.argv[2];
if (command === "start") {
  if (!existsSync(DATA)) {
    run("initdb", ["-D", DATA, "-U", "dli", "-A", "trust", "-E", "UTF8", "--locale=C"]);
  }
  // Detached so the shell is not held open by the server process.
  spawnSync(bin("pg_ctl"), ["-D", DATA, "-o", `-p ${PORT}`, "-l", path.join(DATA, "server.log"), "start", "-w"], { stdio: "ignore", detached: true });
  for (const db of ["dli_portal", "dli_portal_test"]) {
    spawnSync(bin("createdb"), ["-h", "localhost", "-p", PORT, "-U", "dli", db], { stdio: "ignore" });
  }
  console.log(`Local PostgreSQL running on port ${PORT} (databases dli_portal, dli_portal_test).`);
} else if (command === "stop") {
  run("pg_ctl", ["-D", DATA, "stop", "-m", "fast"]);
} else {
  console.log("Usage: node scripts/local-db.mjs start|stop");
}
