import { prisma } from "~/lib/db.server";

// Contadores del NavMenu con caché corta: los auto-revalidates (20s) de cada
// pestaña re-ejecutaban el layout completo (4 queries) y saturaban el pool de
// la BD → las navegaciones en ráfaga subían a ~5s. TTL 10s (tras el switch a
// la red interna counts≈2-8ms); los puntos que cambian el conteo (encolar,
// terminar import, cancelar) llaman a invalidateNavCounts para que el badge
// no espere al próximo ciclo de caché + auto-revalidate.
const navCountsCache = new Map<string, { expires: number; unresolved: number; queue: number }>();
const NAV_COUNTS_TTL_MS = 10_000;

export function invalidateNavCounts(shopDomain: string): void {
  navCountsCache.delete(shopDomain);
}

export async function getNavCounts(
  shopDomain: string,
  hasPlan: boolean
): Promise<{ unresolved: number; queue: number }> {
  if (!hasPlan) return { unresolved: 0, queue: 0 };

  const hit = navCountsCache.get(shopDomain);
  if (hit && hit.expires > Date.now()) {
    return { unresolved: hit.unresolved, queue: hit.queue };
  }

  const [unresolved, queue] = await Promise.all([
    prisma.duplicateLog.count({ where: { shopDomain, resolved: false } }),
    (async () => {
      const [qItems, runningLogs, activeJobs] = await Promise.all([
        prisma.importQueue.findMany({
          where: { shopDomain, status: { in: ["queued", "running"] } },
          select: { configId: true },
        }),
        prisma.importLog.findMany({
          where: { shopDomain, status: "running" },
          select: { configId: true },
        }),
        prisma.bulkJob.findMany({
          where: { shopDomain, phase: { in: ["lookup", "mutations", "finalizing"] } },
          select: { configId: true },
        }),
      ]);
      const ids = new Set<string>();
      for (const x of qItems) ids.add(x.configId);
      for (const x of runningLogs) ids.add(x.configId);
      for (const x of activeJobs) ids.add(x.configId);
      return ids.size;
    })(),
  ]);

  navCountsCache.set(shopDomain, { expires: Date.now() + NAV_COUNTS_TTL_MS, unresolved, queue });
  return { unresolved, queue };
}
