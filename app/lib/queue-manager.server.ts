import { prisma, getConfigById, cleanupOldLogs, ensureSingleSession, ensureFreshToken } from "./db.server";
import { isImportActive, tryAcquireImport, releaseImport, abortImport } from "./import-locks.server";
import shopify from "~/shopify.server";
import { runImport } from "./import-engine.server";
import { runBulkImport } from "./bulk-import.server";
import { sendNotification } from "./notifications.server";

export interface QueueItem {
  id: string;
  shopDomain: string;
  configId: string;
  supplierName: string | null;
  sourceLabel: string | null;
  triggerType: string;
  importMode: string;
  filterType: string | null;
  filterSkus: string | null;
  filterCategories: string | null;
  forceUpdate: boolean;
  position: number;
  status: string;
  logId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  totalProducts?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  excludedCount?: number;
  priceChanges?: number;
  stockChanges?: number;
  errorCount?: number;
  errorDetails?: any[];
}

export async function enqueue(params: {
  shopDomain: string;
  configId: string;
  supplierName?: string;
  sourceLabel?: string;
  triggerType?: string;
  importMode?: string;
  filterType?: string;
  filterSkus?: string;
  filterCategories?: string;
  forceUpdate?: boolean;
}): Promise<QueueItem> {
  const existingForConfig = await prisma.importQueue.findMany({
    where: { configId: params.configId, status: { in: ["queued", "running"] } },
    select: { id: true, status: true },
    orderBy: { createdAt: "asc" },
  });

  const hasRunning = existingForConfig.some((i) => i.status === "running");
  const existingQueued = existingForConfig.find((i) => i.status === "queued");

  if (hasRunning && existingQueued) {
    console.log(`[Queue] Skip enqueue for ${params.configId}: already 1 running + 1 queued`);
    return existingQueued as QueueItem;
  }

  if (hasRunning && !existingQueued) {
    if (existingForConfig.length >= 2) {
      console.log(`[Queue] Skip enqueue for ${params.configId}: already running, will queue next`);
      return existingForConfig[0] as QueueItem;
    }
  }

  if (existingQueued) {
    console.log(`[Queue] Skip enqueue for ${params.configId}: already ${existingForConfig.length} queued/running`);
    return existingQueued as QueueItem;
  }

  const maxPos = await prisma.importQueue.aggregate({
    where: { shopDomain: params.shopDomain, status: { in: ["queued", "running"] } },
    _max: { position: true },
  });

  const item = await prisma.importQueue.create({
    data: {
      shopDomain: params.shopDomain,
      configId: params.configId,
      supplierName: params.supplierName || null,
      sourceLabel: params.sourceLabel || null,
      triggerType: params.triggerType || "manual",
      importMode: params.importMode || "chunks",
      filterType: params.filterType || null,
      filterSkus: params.filterSkus || null,
      filterCategories: params.filterCategories || null,
      forceUpdate: params.forceUpdate || false,
      position: (maxPos._max.position || 0) + 1,
    },
  });

  console.log(`[Queue] Enqueued import for ${params.shopDomain} (configId=${params.configId}, position=${item.position})`);

  await processNext(params.shopDomain);

  return item as QueueItem;
}

export async function processNext(shopDomain: string): Promise<void> {
  // Find all queued items for this shop, grouped by configId
  const queued = await prisma.importQueue.findMany({
    where: { shopDomain, status: "queued" },
    orderBy: { position: "asc" },
  });

  if (queued.length === 0) return;

  for (const item of queued) {
    // Check if this configId already has a running import
    const hasRunning = await prisma.importQueue.findFirst({
      where: { configId: item.configId, status: "running" },
    });
    if (hasRunning) continue;

    // Check if this specific item was cancelled
    const stillQueued = await prisma.importQueue.findUnique({ where: { id: item.id } });
    if (!stillQueued || stillQueued.status !== "queued") continue;

    // Try to acquire import lock
    const lock = tryAcquireImport(item.configId);
    if (!lock) continue;

    // Mark as running
    await prisma.importQueue.update({
      where: { id: item.id },
      data: { status: "running", startedAt: new Date() },
    });

    console.log(`[Queue] Processing import ${item.id} for ${shopDomain} (configId=${item.configId})`);

    processQueueItem(item, lock, shopDomain).catch((error) => {
      console.error(`[Queue] Unhandled error processing ${item.id}:`, error);
    });
  }
}

async function processQueueItem(
  item: any,
  lock: { signal: AbortSignal; abort: () => void },
  shopDomain: string
): Promise<void> {
  const startTime = Date.now();

  try {
    let admin;
    try {
      // Deduplicate sessions before getting admin client
      await ensureSingleSession(shopDomain);
      // Refresh token if about to expire
      const freshToken = await ensureFreshToken(shopDomain);
      if (!freshToken) {
        console.error(`[Queue] Token expirado para ${shopDomain}, saltando importación ${item.id}`);
        await prisma.importQueue.update({
          where: { id: item.id },
          data: { status: "failed", finishedAt: new Date() },
        });
        return;
      }
      console.log(`[Queue] Creating admin client for ${shopDomain} (item ${item.id})`);
      ({ admin } = await shopify.unauthenticated.admin(shopDomain));
      console.log(`[Queue] Admin client OK for ${shopDomain}`);
    } catch (e: any) {
      const msg = e?.message || "";
      console.error(`[Queue] Failed to create admin client for ${shopDomain}:`, msg);
      if (msg.includes("Session not found") || e?.response?.status === 401 || msg.includes("Unauthorized")) {
        console.error(`[Queue] No valid session for ${shopDomain}, skipping import ${item.id}`);
        await prisma.importQueue.update({
          where: { id: item.id },
          data: { status: "failed", finishedAt: new Date() },
        });
        return;
      }
      throw e;
    }

    if (item.importMode === "bulk") {
      const bulkResult = await runBulkImport({
        shopDomain,
        configId: item.configId,
        triggerType: item.triggerType,
        filterType: item.filterType || undefined,
        filterSkus: item.filterSkus || undefined,
        filterCategories: item.filterCategories || undefined,
        forceUpdate: item.forceUpdate,
      });

      // Re-check if the item was already cancelled during import
      const currentItem = await prisma.importQueue.findUnique({ where: { id: item.id }, select: { status: true } });
      if (currentItem?.status === "cancelled") {
        console.log(`[Queue] Bulk import ${item.id} was cancelled during processing, keeping cancelled status`);
        return;
      }

      await prisma.importQueue.update({
        where: { id: item.id },
        data: { status: "completed", finishedAt: new Date(), logId: bulkResult.logId },
      });

      const duration = `${Math.round((Date.now() - startTime) / 1000)}s`;
      await sendNotification({
        shopDomain,
        status: "completed",
        totalProducts: 0, created: 0, updated: 0, unchanged: 0,
        priceChanges: 0, stockChanges: 0, errors: [],
        duration,
      }).catch(() => {});

      await cleanupOldLogs(item.configId).catch(() => {});
    } else {
      // Check for orphan running ImportLog to resume from checkpoint
      const orphanLog = await prisma.importLog.findFirst({
        where: { configId: item.configId, status: "running" },
        select: { id: true, lastSku: true },
        orderBy: { startedAt: "desc" },
      }).catch(() => null);
      const resumeFromSku = orphanLog?.lastSku || undefined;

      if (resumeFromSku) {
        console.log(`[Queue] Resumiendo desde checkpoint SKU: ${resumeFromSku}`);
        // Mark old log as failed (we extracted the checkpoint)
        await prisma.importLog.update({
          where: { id: orphanLog!.id },
          data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: "systemError.replaced_by_resume", lineNumber: 0 }]) },
        }).catch(() => {});
      }

      const result = await runImport({
        shopDomain,
        configId: item.configId,
        admin,
        filterType: item.filterType || undefined,
        filterSkus: item.filterSkus || undefined,
        filterCategories: item.filterCategories || undefined,
        triggerType: item.triggerType,
        signal: lock.signal,
        queueItemId: item.id,
        resumeFromSku,
      });

      // Re-check if the item was already cancelled during import (race condition: cancelQueueItem may have run while import was finishing)
      const currentItem = await prisma.importQueue.findUnique({ where: { id: item.id }, select: { status: true } });
      if (currentItem?.status === "cancelled") {
        console.log(`[Queue] Import ${item.id} was cancelled during processing, keeping cancelled status`);
        return;
      }

      const duration = `${Math.round((Date.now() - startTime) / 1000)}s`;
      await prisma.importQueue.update({
        where: { id: item.id },
        data: { status: "completed", finishedAt: new Date(), logId: result.logId },
      });

      await sendNotification({
        shopDomain,
        status: result.errors.length > 0 ? "completed_with_errors" : "completed",
        totalProducts: result.totalProducts,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        priceChanges: result.priceChanges,
        stockChanges: result.stockChanges,
        errors: result.errors,
        duration,
      }).catch(() => {});

      await cleanupOldLogs(item.configId).catch(() => {});
    }
  } catch (error: any) {
    if (error?.name === "AbortError") {
      console.log(`[Queue] Import ${item.id} cancelled`);
      await prisma.importQueue.update({
        where: { id: item.id },
        data: { status: "cancelled", finishedAt: new Date() },
      });
    } else {
      console.error(`[Queue] Import ${item.id} failed:`, error?.message);
      await prisma.importQueue.update({
        where: { id: item.id },
        data: { status: "failed", finishedAt: new Date() },
      });

      await sendNotification({
        shopDomain,
        status: "failed",
        totalProducts: 0, created: 0, updated: 0, unchanged: 0,
        priceChanges: 0, stockChanges: 0,
        errors: [{ sku: "SYSTEM", error: error?.message || "systemError.unknown_error", lineNumber: 0 }],
        duration: `${Math.round((Date.now() - startTime) / 1000)}s`,
      }).catch(() => {});
    }
  } finally {
    releaseImport(item.configId);
  }

  // Only process next queued items for manual imports.
  // Scheduled imports are managed by the scheduler — it handles timing and cooldown.
  if (item.triggerType !== "scheduled") {
    await processNext(shopDomain);
  }
}

export async function cancelQueueItem(itemId: string, shopDomain: string): Promise<{ success: boolean; message: string }> {
  const item = await prisma.importQueue.findUnique({ where: { id: itemId } });
  if (!item) return { success: false, message: "Item no encontrado" };

  if (item.status === "queued" || item.status === "failed" || item.status === "cancelled") {
    await prisma.importQueue.update({
      where: { id: itemId },
      data: { status: "cancelled", finishedAt: item.finishedAt || new Date() },
    });
    return { success: true, message: "Importación descartada de la cola" };
  }

  if (item.status === "running") {
    // Abort the actual import process
    const aborted = abortImport(item.configId);
    await prisma.importQueue.update({
      where: { id: itemId },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    // Also mark the ImportLog as failed
    if (item.logId) {
      await prisma.importLog.update({
        where: { id: item.logId },
        data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: "systemError.cancelled_manually" }]) },
      }).catch(() => {});
    }
    await sendNotification({
      shopDomain,
      status: "cancelled",
      totalProducts: 0, created: 0, updated: 0, unchanged: 0,
      priceChanges: 0, stockChanges: 0,
      errors: [{ sku: "SYSTEM", error: "systemError.cancelled_manually" }],
      duration: "0s",
    }).catch(() => {});
    return { success: true, message: aborted ? "Importación abortada" : "Importación marcada para cancelar" };
  }

  return { success: false, message: `No se puede cancelar: estado "${item.status}"` };
}

export async function getQueueStatus(shopDomain: string): Promise<{
  active: QueueItem[];
  queued: QueueItem[];
  recent: QueueItem[];
  schedulerActive: Array<{
    configId: string;
    supplierName: string | null;
    sourceLabel: string | null;
    triggerType: string;
    importMode: string;
    logId: string | null;
    bulkJobId?: string | null;
    progress: {
      totalProducts: number;
      processedProducts: number;
      lastSku: string;
      status: string;
      errors: number;
    } | null;
  }>;
}> {
  const [active, queued] = await Promise.all([
    prisma.importQueue.findMany({
      where: { shopDomain, status: "running" },
      orderBy: { position: "asc" },
    }),
    prisma.importQueue.findMany({
      where: { shopDomain, status: "queued" },
      orderBy: { position: "asc" },
    }),
  ]);

  // Find scheduler-active imports for this shop
  const schedulerActive: Array<{
    configId: string;
    supplierName: string | null;
    sourceLabel: string | null;
    triggerType: string;
    importMode: string;
    logId: string | null;
    bulkJobId?: string | null;
    progress: any;
  }> = [];
  const seenConfigIds = new Set<string>();

  // From running ImportLogs not in queue (survives restart, edge cases)
  const activeConfigIds = new Set(active.map((a) => a.configId));
  const runningLogs = await prisma.importLog.findMany({
    where: { shopDomain, status: "running" },
    orderBy: { startedAt: "desc" },
    select: {
      id: true, configId: true, totalProducts: true, created: true, updated: true,
      unchanged: true, excludedCount: true, errors: true, lastSku: true, triggerType: true,
    },
  });
  for (const log of runningLogs) {
    if (seenConfigIds.has(log.configId)) continue;
    if (activeConfigIds.has(log.configId)) continue;

    // Skip if there's an active BulkJob for this config (bulk is still processing)
    const hasActiveBulkJob = await prisma.bulkJob.findFirst({
      where: { configId: log.configId, phase: { in: ["lookup", "mutations", "finalizing"] } },
      select: { id: true },
    }).catch(() => null);
    if (hasActiveBulkJob) continue;

    seenConfigIds.add(log.configId);
    const config = await prisma.importConfig.findUnique({
      where: { id: log.configId },
      select: { id: true, name: true, csvUrl: true, importMode: true, dataSource: true, localFilePath: true },
    });

    // Show even if config was deleted — otherwise it's invisible
    const sourceLabel = !config
      ? "Configuración eliminada"
      : config.dataSource === "file"
        ? config.localFilePath?.split(/[/\\]/).pop() || "Archivo local"
        : config.csvUrl || "URL";

    const processed = (log.created || 0) + (log.updated || 0) + (log.unchanged || 0) + (log.excludedCount || 0);
    const errorCount = log.errors ? (JSON.parse(log.errors) as any[]).length : 0;

    schedulerActive.push({
      configId: log.configId,
      supplierName: config?.name || null,
      sourceLabel,
      triggerType: log.triggerType || "scheduled",
      importMode: config?.importMode || "chunks",
      logId: log.id,
      progress: {
        totalProducts: log.totalProducts || 0,
        processedProducts: processed,
        lastSku: log.lastSku || "",
        status: "running",
        errors: errorCount,
      },
    });
  }

  // 2. From active BulkJobs (bulk mode - async, continues after scheduler releases)
  const activeBulkJobs = await prisma.bulkJob.findMany({
    where: { shopDomain, phase: { in: ["lookup", "mutations", "finalizing"] } },
    select: { id: true, configId: true, logId: true, phase: true, totalCount: true, createCount: true, updateCount: true, unchangedCount: true, excludedCount: true },
  });

  for (const bulkJob of activeBulkJobs) {
    if (schedulerActive.some((s) => s.configId === bulkJob.configId)) continue;
    if (activeConfigIds.has(bulkJob.configId)) continue;

    const config = await prisma.importConfig.findUnique({
      where: { id: bulkJob.configId },
      select: { id: true, name: true, csvUrl: true, importMode: true, dataSource: true, localFilePath: true },
    });

    // Show BulkJob even if config was deleted — otherwise it's invisible and unkillable
    const sourceLabel = !config
      ? "Configuración eliminada"
      : config.dataSource === "file"
        ? config.localFilePath?.split(/[/\\]/).pop() || "Archivo local"
        : config.csvUrl || "URL";

    let progress = null;
    if (bulkJob.logId) {
      const log = await prisma.importLog.findUnique({
        where: { id: bulkJob.logId },
        select: {
          id: true, totalProducts: true, created: true, updated: true,
          unchanged: true, excludedCount: true, errors: true, lastSku: true, status: true,
        },
      });
      if (log) {
        const processed = (log.created || 0) + (log.updated || 0) + (log.unchanged || 0) + (log.excludedCount || 0);
        const errorCount = log.errors ? (JSON.parse(log.errors) as any[]).length : 0;
        // For bulk: use BulkJob counts (more accurate than ImportLog during processing)
        // Fall back to ImportLog when BulkJob counters are still 0 (before first webhook)
        const total = bulkJob.totalCount || log.totalProducts || 0;
        const done = (bulkJob.createCount || 0) + (bulkJob.updateCount || 0) + (bulkJob.unchangedCount || 0) + (bulkJob.excludedCount || 0);
        progress = {
          totalProducts: total,
          processedProducts: done || processed,
          lastSku: log.lastSku || "",
          status: log.status,
          errors: errorCount,
          created: bulkJob.createCount || log.created || 0,
          updated: bulkJob.updateCount || log.updated || 0,
          unchanged: bulkJob.unchangedCount || log.unchanged || 0,
          phase: bulkJob.phase,
        };
      }
    }

    schedulerActive.push({
      configId: bulkJob.configId,
      supplierName: config?.name || null,
      sourceLabel,
      triggerType: "scheduled",
      importMode: "bulk",
      logId: bulkJob.logId,
      bulkJobId: bulkJob.id,
      progress,
    });
  }

  // Recent imports: just query ImportLog directly (same as supplier history)
  const recentLogs = await prisma.importLog.findMany({
    where: {
      shopDomain,
      status: { in: ["completed", "failed", "completed_with_errors", "cancelled"] },
    },
    orderBy: { startedAt: "desc" },
    take: 10,
    select: {
      id: true, configId: true, status: true, triggerType: true,
      startedAt: true, completedAt: true, created: true, updated: true, unchanged: true,
      totalProducts: true, excludedCount: true, priceChanges: true, stockChanges: true, errors: true,
    },
  });

  const recentLogConfigs = recentLogs.length > 0
    ? await prisma.importConfig.findMany({
        where: { id: { in: [...new Set(recentLogs.map((l) => l.configId))] } },
        select: { id: true, name: true, csvUrl: true, dataSource: true, localFilePath: true, importMode: true },
      })
    : [];
  const configMap = new Map(recentLogConfigs.map((c) => [c.id, c]));

  const allRecent: QueueItem[] = recentLogs.map((log) => {
    const cfg = configMap.get(log.configId);
    const sourceLabel = cfg?.dataSource === "file"
      ? cfg.localFilePath?.split(/[/\\]/).pop() || "Archivo local"
      : cfg?.csvUrl || "URL";
    const errorDetails = log.errors ? JSON.parse(log.errors) as any[] : [];
    return {
      id: log.id,
      shopDomain,
      configId: log.configId,
      supplierName: cfg?.name || null,
      sourceLabel,
      triggerType: log.triggerType || "scheduled",
      importMode: cfg?.importMode || "chunks",
      filterType: null,
      filterSkus: null,
      filterCategories: null,
      forceUpdate: false,
      position: 0,
      status: log.status,
      logId: log.id,
      startedAt: log.startedAt,
      finishedAt: log.completedAt,
      createdAt: log.startedAt || new Date(),
      totalProducts: log.totalProducts || 0,
      created: log.created || 0,
      updated: log.updated || 0,
      unchanged: log.unchanged || 0,
      excludedCount: log.excludedCount || 0,
      priceChanges: log.priceChanges || 0,
      stockChanges: log.stockChanges || 0,
      errorCount: errorDetails.length,
      errorDetails,
    };
  });

  return {
    active: active as QueueItem[],
    queued: queued as QueueItem[],
    recent: allRecent,
    schedulerActive,
  };
}

export async function clearCompleted(shopDomain: string): Promise<{ success: boolean; deleted: number }> {
  const result = await prisma.importQueue.deleteMany({
    where: {
      shopDomain,
      status: { in: ["completed", "failed", "cancelled"] },
    },
  });
  console.log(`[Queue] Cleared ${result.count} completed items for ${shopDomain}`);
  return { success: true, deleted: result.count };
}

export async function getQueueItemProgress(itemId: string): Promise<{
  totalProducts: number;
  processedProducts: number;
  lastSku: string;
  status: string;
  errors: number;
} | null> {
  const item = await prisma.importQueue.findUnique({ where: { id: itemId } });
  if (!item || !item.logId) return null;

  const log = await prisma.importLog.findUnique({
    where: { id: item.logId },
    select: {
      totalProducts: true,
      created: true,
      updated: true,
      unchanged: true,
      excludedCount: true,
      errors: true,
      lastSku: true,
      status: true,
    },
  });

  if (!log) return null;

  const processed = (log.created || 0) + (log.updated || 0) + (log.unchanged || 0) + (log.excludedCount || 0);
  const errorCount = log.errors ? (JSON.parse(log.errors) as any[]).length : 0;

  return {
    totalProducts: log.totalProducts || 0,
    processedProducts: processed,
    lastSku: log.lastSku || "",
    status: log.status,
    errors: errorCount,
  };
}
