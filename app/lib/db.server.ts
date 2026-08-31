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
