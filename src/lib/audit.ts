import type { Db } from "./db";

export type ActorType = "student" | "admin" | "system";

/**
 * Append an audit record. Metadata must never contain PINs, passwords, session tokens or
 * complaint text; record identifiers and changed field names/values only.
 */
export async function audit(
  db: Db,
  entry: {
    actorType: ActorType;
    actorId?: string | null;
    action: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  },
) {
  await db.query(
    `insert into audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}
