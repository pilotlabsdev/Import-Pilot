import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

const prisma = global.prisma || new PrismaClient({
  log: ["error", "warn"],
  datasourceUrl: process.env.DATABASE_URL,
});

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}

export { prisma };

/**
 * Returns the effective data source URL for a config.
 * If dataSource is "file", returns localFilePath. Otherwise returns csvUrl.
 */
export function getEffectiveUrl(config: { dataSource?: string | null; csvUrl?: string; localFilePath?: string | null }): string {
  if (config.dataSource === "file" && config.localFilePath) {
    return config.localFilePath;
  }
  return config.csvUrl || "";
}

/**
 * Check if the data source is a URL (http/https).
 */
export function isUrlSource(config: { dataSource?: string | null }): boolean {
  return config.dataSource !== "file";
}

/**
 * Delete all sessions for a shop except the given one.
 * Called after OAuth (afterAuth hook) to prevent stale sessions from
 * accumulating when a merchant reinstalls. The PrismaSessionStorage
 * upserts by session.id (PK), not by shop — so reinstalling creates
 * a new row instead of updating the old one.
 */
export async function cleanupDuplicateSessions(shop: string, keepSessionId: string): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: {
      shop,
      id: { not: keepSessionId },
    },
  });
  if (result.count > 0) {
    console.log(`[Session] Cleaned up ${result.count} stale session(s) for ${shop}`);
  }
  return result.count;
}

/**
 * Ensure there's only one valid session for a shop.
 * Returns the best session (the one with the latest expiry), or null.
 * Called before bulk import to guarantee the correct token is used.
 */
export async function ensureSingleSession(shop: string): Promise<{ id: string; accessToken: string; expires: Date | null } | null> {
  const sessions = await prisma.session.findMany({
    where: { shop },
    orderBy: { expires: "desc" },
    select: { id: true, accessToken: true, expires: true },
  });

  if (sessions.length === 0) return null;

  // If more than one session exists, delete all but the newest
  if (sessions.length > 1) {
    const [best, ...stale] = sessions;
    const idsToDelete = stale.map((s) => s.id);
    await prisma.session.deleteMany({ where: { id: { in: idsToDelete } } });
    console.log(`[Session] Deduped ${idsToDelete.length} stale session(s) for ${shop}, kept ${best.id}`);
    return best;
  }

  return sessions[0];
}

/**
 * Returns a unique key for the current data source.
 * Used to scope column mappings per source (URL vs file).
 */
export function getSourceKey(config: { dataSource?: string | null; csvUrl?: string; localFilePath?: string | null }): string {
  if (config.dataSource === "file" && config.localFilePath) return `file:${config.localFilePath}`;
  if (config.csvUrl) return `url:${config.csvUrl}`;
  return "default";
}

/**
 * Get or create the first ImportConfig for a shop.
 * Used for backward compatibility during multi-supplier migration.
 * When multiple configs exist, returns the most recently active one,
 * or the most recently created one.
 */
export async function getOrCreateConfig(shopDomain: string) {
  const existing = await prisma.importConfig.findFirst({
    where: { shopDomain },
    orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
  });
  if (existing) return existing;

  return prisma.importConfig.create({
    data: {
      shopDomain,
      csvUrl: "",
      name: "Proveedor",
    },
  });
}

/**
 * Get a specific ImportConfig by ID
 */
export async function getConfigById(id: string) {
  return prisma.importConfig.findUnique({ where: { id } });
}

const MAX_LOGS_PER_CONFIG = 100;

export async function cleanupOldLogs(configId: string): Promise<number> {
  const allLogs = await prisma.importLog.findMany({
    where: { configId },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });

  if (allLogs.length <= MAX_LOGS_PER_CONFIG) return 0;

  const idsToDelete = allLogs.slice(MAX_LOGS_PER_CONFIG).map((l) => l.id);
  const result = await prisma.importLog.deleteMany({
    where: { id: { in: idsToDelete } },
  });

  console.log(`[Cleanup] Deleted ${result.count} old logs for config ${configId}`);
  return result.count;
}
