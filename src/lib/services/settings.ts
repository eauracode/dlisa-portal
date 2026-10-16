import { z } from "zod";
import { one, type Db } from "../db";
import { audit } from "../audit";
import { DEFAULT_MATCHING_CONFIG, type MatchingConfig } from "../matching/engine";
import { DEFAULT_PRIORITY_CONFIG, type PriorityConfig } from "../priority/engine";

const unit = z.coerce.number().min(0).max(1);

export const matchingSettingsSchema = z
  .object({
    autoThreshold: unit,
    reviewThreshold: unit,
    ambiguityMargin: z.coerce.number().min(0).max(0.5),
    resolvedLookbackDays: z.coerce.number().int().min(0).max(730),
  })
  .refine((v) => v.reviewThreshold < v.autoThreshold, {
    message: "The review threshold must be lower than the automatic-grouping threshold.",
    path: ["reviewThreshold"],
  });

const points = z.coerce.number().min(0).max(100);
export const prioritySettingsSchema = z
  .object({
    elevated: points,
    high: points,
    critical: points,
    overduePoints: points,
    academicImpactPoints: points,
  })
  .refine((v) => v.elevated < v.high && v.high < v.critical, {
    message: "Thresholds must increase: elevated < high < critical.",
    path: ["high"],
  });

export async function getMatchingConfig(db: Db): Promise<MatchingConfig> {
  const row = await one<{ value: unknown }>(db, `select value from app_settings where key = 'matching'`);
  const parsed = matchingSettingsSchema.safeParse({ ...DEFAULT_MATCHING_CONFIG, ...(row?.value as object | undefined) });
  return parsed.success ? parsed.data : DEFAULT_MATCHING_CONFIG;
}

export async function getPriorityConfig(db: Db): Promise<PriorityConfig> {
  const row = await one<{ value: unknown }>(db, `select value from app_settings where key = 'priority'`);
  const d = DEFAULT_PRIORITY_CONFIG;
  const parsed = prioritySettingsSchema.safeParse({
    ...d.thresholds,
    overduePoints: d.overduePoints,
    academicImpactPoints: d.academicImpactPoints,
    ...(row?.value as object | undefined),
  });
  if (!parsed.success) return d;
  const { elevated, high, critical, overduePoints, academicImpactPoints } = parsed.data;
  return { ...d, thresholds: { elevated, high, critical }, overduePoints, academicImpactPoints };
}

export async function saveSetting(db: Db, key: "matching" | "priority", value: object, adminId: string) {
  await db.query(
    `insert into app_settings (key, value, updated_at, updated_by) values ($1, $2, now(), $3)
     on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [key, JSON.stringify(value), adminId],
  );
  await audit(db, { actorType: "admin", actorId: adminId, action: `settings.${key}_updated`, entityType: "app_settings", entityId: key, metadata: value as Record<string, unknown> });
}
