/**
 * Server-side read/write of the usage_mode / view_scope settings rows. Same
 * storage as dev_mode (settings(key, user_id, value), upsert on the PK), so no
 * migration. Reads never throw: an unreadable row degrades to the default.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  USAGE_MODE_KEY,
  VIEW_SCOPE_KEY,
  usageModeFromStored,
  viewScopeFromStored,
  type UsageMode,
  type ViewScope,
} from "@/lib/view-scope";

async function readSetting(userId: string, key: string): Promise<string | null> {
  try {
    const row = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(and(eq(schema.settings.key, key), eq(schema.settings.userId, userId)))
      .then((rows) => rows[0]);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function writeSetting(userId: string, key: string, value: string): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key, userId, value })
    .onConflictDoUpdate({
      target: [schema.settings.key, schema.settings.userId],
      set: { value },
    });
}

export async function getUsageMode(userId: string): Promise<UsageMode> {
  return usageModeFromStored(await readSetting(userId, USAGE_MODE_KEY));
}

export async function setUsageMode(userId: string, mode: UsageMode): Promise<void> {
  await writeSetting(userId, USAGE_MODE_KEY, mode);
}

export async function getViewScope(userId: string): Promise<ViewScope> {
  return viewScopeFromStored(await readSetting(userId, VIEW_SCOPE_KEY));
}

export async function setViewScope(userId: string, scope: ViewScope): Promise<void> {
  await writeSetting(userId, VIEW_SCOPE_KEY, scope);
}
