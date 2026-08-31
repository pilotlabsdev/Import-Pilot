/**
 * Migrate data from SQLite (dev.sqlite) to Prisma Postgres.
 * Run: npx tsx scripts/migrate-sqlite-to-postgres.ts
 */
import Database from "better-sqlite3";
import { PrismaClient } from "@prisma/client";
import path from "path";

const SQLITE_PATH = path.join(__dirname, "..", "prisma", "dev.sqlite");
const BATCH_SIZE = 100;

const postgres = new PrismaClient();
const sqlite = new Database(SQLITE_PATH, { readonly: true });

const TABLES_IN_ORDER = [
  "Session",
  "ShopSettings",
  "AppSubscription",
  "DevStatus",
  "ImportConfig",
  "ColumnMapping",
  "PriceRule",
  "CategoryCollectionMapping",
  "ImportLog",
  "ProductMapping",
  "BulkJob",
  "BulkJobOp",
  "NotificationConfig",
  "ImportQueue",
  "DuplicateLog",
  "SupportMessage",
] as const;

// Fields that are DateTime in PostgreSQL (stored as integer timestamps in SQLite)
const DATETIME_FIELDS = new Set([
  "expires", "createdAt", "updatedAt", "startedAt", "completedAt",
  "finishedAt", "detectedAt", "lastImportAt", "lastSyncAt",
  "lastPingAt", "readAt", "trialEndsAt", "refreshTokenExpires",
]);

// Fields that are Boolean in PostgreSQL (stored as 0/1 in SQLite)
const BOOLEAN_FIELDS = new Set([
  "isOnline", "accountOwner", "collaborator", "emailVerified",
  "isActive", "isRequired", "comparePriceEnabled", "forceUpdate",
  "planPaused", "active", "resolved", "emailEnabled", "webhookEnabled",
  "notifyOnSuccess", "notifyOnError", "notifyOnPriceChange",
  "skipZeroStockCreate", "hasUsedTrial",
]);

function convertRow(row: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    if (DATETIME_FIELDS.has(key) && typeof value === "number") {
      cleaned[key] = new Date(value);
    } else if (BOOLEAN_FIELDS.has(key) && typeof value === "number") {
      cleaned[key] = value === 1;
    } else {
      cleaned[key] = value ?? null;
    }
  }
  return cleaned;
}

function getTableName(modelName: string): string {
  // Prisma lowercase first letter for model access
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

async function migrateTable(tableName: string): Promise<number> {
  const rows = sqlite.prepare(`SELECT * FROM "${tableName}"`).all() as Record<string, any>[];
  if (rows.length === 0) return 0;

  let migrated = 0;
  let errors = 0;
  const prismaModel = (postgres as any)[getTableName(tableName)];

  if (!prismaModel) {
    console.log(`  ⚠ Model not found for ${tableName}, skipping`);
    return 0;
  }

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    for (const row of batch) {
      const cleaned = convertRow(row);
      try {
        await prismaModel.create({ data: cleaned });
        migrated++;
      } catch (err: any) {
        errors++;
        if (errors <= 3) {
          console.error(`  ✗ Error in ${tableName}: ${err.message.split("\n")[0]}`);
        }
      }
    }
  }

  if (errors > 3) {
    console.log(`  ... and ${errors - 3} more errors`);
  }

  return migrated;
}

async function main() {
  console.log("=== SQLite → PostgreSQL Migration ===\n");

  const counts = TABLES_IN_ORDER.map((t) => {
    const count = sqlite.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get() as any;
    return { table: t, count: count.c };
  });

  console.log("SQLite row counts:");
  for (const { table, count } of counts) {
    if (count > 0) console.log(`  ${table}: ${count}`);
  }
  console.log("");

  const results: Record<string, { sqlite: number; postgres: number }> = {};

  for (const tableName of TABLES_IN_ORDER) {
    const sqliteCount = counts.find((t) => t.table === tableName)?.count || 0;
    if (sqliteCount === 0) continue;

    console.log(`📦 ${tableName}: migrating ${sqliteCount} rows...`);
    const migrated = await migrateTable(tableName);
    console.log(`  ✓ ${migrated}/${sqliteCount} migrated`);
    results[tableName] = { sqlite: sqliteCount, postgres: migrated };
  }

  console.log("\n=== Verification ===");
  for (const tableName of TABLES_IN_ORDER) {
    if (!results[tableName]) continue;
    const prismaModel = (postgres as any)[getTableName(tableName)];
    if (prismaModel) {
      const pgCount = await prismaModel.count();
      const status = pgCount === results[tableName].sqlite ? "✓" : "✗";
      console.log(`  ${status} ${tableName}: SQLite=${results[tableName].sqlite} → PG=${pgCount}`);
    }
  }

  console.log("\n=== Done ===");
  sqlite.close();
  await postgres.$disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
