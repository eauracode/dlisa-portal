import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env";

/**
 * Anything that can run a query: the pool (autocommit) or a client inside a transaction.
 * Every query in the application is parameterised; never interpolate user input into SQL.
 */
export type Db = Pick<PoolClient, "query">;

const globalForPool = globalThis as unknown as { __dliPool?: Pool };

export function pool(): Pool {
  if (!globalForPool.__dliPool) {
    const e = env();
    globalForPool.__dliPool = new Pool({
      connectionString: e.DATABASE_URL,
      ssl: e.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return globalForPool.__dliPool;
}

export async function closePool() {
  if (globalForPool.__dliPool) {
    await globalForPool.__dliPool.end();
    globalForPool.__dliPool = undefined;
  }
}

export async function rows<T extends QueryResultRow>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function one<T extends QueryResultRow>(db: Db, text: string, params: unknown[] = []): Promise<T | null> {
  const res = await db.query<T>(text, params);
  return res.rows[0] ?? null;
}

/** Privileged (system/staff) transaction. Authorisation must be checked by the caller. */
export async function withTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` as the restricted `portal_student` database role with row-level security bound
 * to `studentId`. Queries inside can only ever see that student's own complaints and the
 * student-safe columns of their related issues, regardless of the ids they pass.
 */
export async function withStudentContext<T>(studentId: string, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(async (tx) => {
    await tx.query("set local role portal_student");
    await tx.query("select set_config('app.student_id', $1, true)", [studentId]);
    return fn(tx);
  });
}

/** Runs `fn` as the `portal_public` role, which can read only approved public issue data. */
export async function withPublicContext<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(async (tx) => {
    await tx.query("set local role portal_public");
    return fn(tx);
  });
}
