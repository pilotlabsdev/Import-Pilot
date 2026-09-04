import { prisma, isUrlSource } from "./db.server";
import { enqueue, processNext } from "./queue-manager.server";
import { reconcileStaleBulkJobs, cleanupFinishedBulkJobs, handleBulkOperationFinish, getFreshAdminClient } from "./bulk-import.server";
import { reconcileAllShops } from "./reconciliation.server";
import { isImportActive } from "./import-locks.server";
import { getSubscriptionInfo, enforcePlanLimits } from "./billing.server";
import shopify from "~/shopify.server";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const scheduledFrequencies = new Map<string, string>();
const pendingRetries = new Set<string>();
const IMPORT_COOLDOWN_MS = 600_000;
let started = false;
let refreshing = false;
let reconcileCounter = 0;
const RECONCILE_INTERVAL = 60;
const configStaggerOffset = new Map<string, number>();
const configLocks = new Set<string>();

function getFrequencyMs(frequency: string): number | null {
  const map: Record<string, number> = {
    "30min": 30 * 60 * 1000,
    hourly: 60 * 60 * 1000,
    "2h": 2 * 60 * 60 * 1000,
    "3h": 3 * 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
  };
  return map[frequency] || null;
}

function getStaggerOffset(configId: string): number {
  if (!configStaggerOffset.has(configId)) {
    configStaggerOffset.set(configId, Math.floor(Math.random() * 120_000));
  }
  return configStaggerOffset.get(configId)!;
}

function scheduleNext(configId: string, frequency: string, lastImportAt: Date | null, retryMs?: number) {
  const existing = timers.get(configId);
  if (existing) clearTimeout(existing);

  let delay: number;

  if (retryMs) {
    delay = retryMs;
  } else {
    const freqMs = getFrequencyMs(frequency);
    if (!freqMs) return;

    const now = Date.now();
    const referenceTime = lastImportAt ? lastImportAt.getTime() : 0;

    const elapsed = now - referenceTime;
    const stagger = getStaggerOffset(configId);
    delay = Math.max(freqMs - elapsed + stagger, 10_000);
  }

  const nextRunAt = new Date(Date.now() + delay);
  console.log(`[Scheduler] ${configId.slice(0, 8)} próximo import en ${Math.round(delay / 60_000)} min (${nextRunAt.toLocaleTimeString("es-ES")})`);

  const timer = setTimeout(() => {
    void runScheduledImport(configId);
  }, delay);

  timers.set(configId, timer);
}

async function resumeInterruptedJobs() {
  try {
    // Find ImportQueue items stuck in "running" (interrupted by crash/restart)
    const runningItems = await prisma.importQueue.findMany({
      where: { status: "running" },
      select: { id: true, shopDomain: true, configId: true },
    });

    if (runningItems.length > 0) {
      console.log(`[Scheduler] Reanudando ${runningItems.length} imports interrumpidos`);
      // Reset to queued so processNext picks them up
      for (const item of runningItems) {
        await prisma.importQueue.update({
          where: { id: item.id },
          data: { status: "queued" },
        }).catch(() => {});
      }
      // Trigger processing for each affected shop
      const shops = [...new Set(runningItems.map((i) => i.shopDomain))];
      for (const shop of shops) {
        void processNext(shop).catch(() => {});
      }
    }

    // Also find orphan ImportLogs (status "running" with no queue item)
    const orphanLogs = await prisma.importLog.findMany({
      where: { status: "running" },
      select: { id: true, shopDomain: true, configId: true, triggerType: true },
    });

    for (const log of orphanLogs) {
      const hasQueueItem = await prisma.importQueue.findFirst({
        where: { logId: log.id },
        select: { id: true },
      }).catch(() => null);
      if (!hasQueueItem) {
        // Create new queue item to resume
        const config = await prisma.importConfig.findUnique({
          where: { id: log.configId },
          select: { name: true, csvUrl: true, importMode: true, localFilePath: true, dataSource: true },
        }).catch(() => null);
        if (config) {
          const sourceLabel = config.dataSource === "file"
            ? config.localFilePath?.split(/[/\\]/).pop() || "Archivo local"
            : config.csvUrl || "URL";
          console.log(`[Scheduler] Reanudando orphan log ${log.id.slice(0, 8)} (${config.name})`);
          await enqueue({
            shopDomain: log.shopDomain,
            configId: log.configId,
            supplierName: config.name,
            sourceLabel,
            triggerType: log.triggerType || "scheduled",
            importMode: config.importMode,
          }).catch(() => {});
        }
      }
    }
  } catch (error) {
    console.error("[Scheduler] Error resuming interrupted jobs:", error);
  }
}

async function checkBulkOperations() {
  try {
    // Get all shops with active BulkJobs
    const activeJobs = await prisma.bulkJob.findMany({
      where: { phase: { notIn: ["done", "failed"] } },
      select: { shopDomain: true },
      distinct: ["shopDomain"],
    });

    for (const { shopDomain } of activeJobs) {
      try {
        const admin = await getFreshAdminClient(shopDomain);
        const res = await admin.graphql(`query { currentBulkOperation { id status objectCount errorCode } }`);
        const json = await res.json();
        const op = json.data?.currentBulkOperation;

        if (!op || !op.id) continue;

        if (op.status === "COMPLETED") {
          // Check if we know about this operation
          const knownOp = await prisma.bulkJobOp.findUnique({
            where: { shopifyOpId: op.id },
            select: { id: true, status: true },
          }).catch(() => null);

          if (knownOp && knownOp.status !== "processed") {
            console.log(`[Scheduler] Bulk orphan detectado: ${op.id} en ${shopDomain}, procesando`);
            await handleBulkOperationFinish({ admin, opId: op.id, status: "COMPLETED" }).catch((e) =>
              console.error(`[Scheduler] Error procesando bulk orphan ${op.id}:`, e?.message)
            );
          }
        }
      } catch (e: any) {
        console.error(`[Scheduler] Error checking bulk ops for ${shopDomain}:`, e?.message);
      }
    }
  } catch (e) {
    console.error("[Scheduler] Error in checkBulkOperations:", e);
  }
}

async function startupCleanup(): Promise<void> {
  console.log("[Scheduler] Running startup cleanup...");

  // 1. Fail stuck BulkJobs (from previous process killed by SIGTERM/OOM)
  const stuckBulkJobs = await prisma.bulkJob.findMany({
    where: { phase: { in: ["lookup", "mutations", "finalizing"] } },
    select: { id: true, configId: true, shopDomain: true, logId: true, phase: true },
  });

  for (const job of stuckBulkJobs) {
    console.log(`[Scheduler] Startup: failing stuck BulkJob ${job.id.slice(0,8)} (phase=${job.phase})`);
    await prisma.bulkJob.update({
      where: { id: job.id },
      data: { phase: "failed" },
    }).catch(() => {});

    // Fail associated ImportLog
    if (job.logId) {
      await prisma.importLog.update({
        where: { id: job.logId },
        data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: "systemError.process_restarted", lineNumber: 0 }]) },
      }).catch(() => {});
    }

    // Release associated queue items
    await prisma.importQueue.updateMany({
      where: { configId: job.configId, status: "running" },
      data: { status: "failed", finishedAt: new Date() },
    }).catch(() => {});
  }

  // 2. Fail stuck ImportLogs (status "running" from previous process)
  const stuckLogs = await prisma.importLog.findMany({
    where: { status: "running" },
    select: { id: true, configId: true },
  });
  for (const log of stuckLogs) {
    console.log(`[Scheduler] Startup: failing stuck ImportLog ${log.id.slice(0,8)}`);
    await prisma.importLog.update({
      where: { id: log.id },
      data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: "systemError.process_restarted", lineNumber: 0 }]) },
    }).catch(() => {});
    await prisma.importQueue.updateMany({
      where: { configId: log.configId, logId: log.id, status: "running" },
      data: { status: "failed", finishedAt: new Date() },
    }).catch(() => {});
  }

  // 3. Fail stuck queue items (status "running" with no matching active process)
  const stuckQueue = await prisma.importQueue.findMany({
    where: { status: "running" },
    select: { id: true, configId: true, shopDomain: true },
  });
  for (const item of stuckQueue) {
    console.log(`[Scheduler] Startup: failing stuck queue item ${item.id.slice(0,8)}`);
    await prisma.importQueue.update({
      where: { id: item.id },
      data: { status: "failed", finishedAt: new Date() },
    }).catch(() => {});
  }

  // 4. Process any remaining queued items
  const shops = new Set(stuckBulkJobs.map((j) => j.shopDomain).concat(stuckQueue.map((q) => q.shopDomain)));
  for (const shop of shops) {
    void processNext(shop).catch(() => {});
  }

  const totalFreed = stuckBulkJobs.length + stuckLogs.length + stuckQueue.length;
  if (totalFreed > 0) {
    console.log(`[Scheduler] Startup cleanup: freed ${stuckBulkJobs.length} BulkJobs, ${stuckLogs.length} ImportLogs, ${stuckQueue.length} queue items`);
  }
}

export function startScheduler() {
  if (started) return;
  started = true;
  console.log("[Scheduler] Iniciando scheduler de importaciones...");

  // Startup cleanup: fail stuck BulkJobs and queue items from previous process (e.g. SIGTERM)
  void startupCleanup().catch((error: any) =>
    console.error("[Scheduler] Error en startup cleanup:", error)
  );

  setInterval(() => {
    void reconcileStaleBulkJobs().catch((error: any) =>
      console.error("[Scheduler] Error en reconciliación de bulk jobs:", error)
    );
    void cleanupFinishedBulkJobs().catch((error: any) =>
      console.error("[Scheduler] Error en limpieza de bulk jobs:", error)
    );
    void checkBulkOperations().catch((error: any) =>
      console.error("[Scheduler] Error en checkBulkOperations:", error)
    );
    reconcileCounter++;
    if (reconcileCounter >= RECONCILE_INTERVAL) {
      reconcileCounter = 0;
      void reconcileAllShops().catch((error: any) =>
        console.error("[Scheduler] Error en reconciliación de mappings huérfanos:", error)
      );
    }

    // Clean stale queue items (queued >30min, running with no progress >15min)
    const STALE_QUEUED_MS = 30 * 60 * 1000;
    const STALE_PROGRESS_MS = 15 * 60 * 1000;
    void prisma.importQueue.deleteMany({
      where: {
        status: "queued",
        createdAt: { lt: new Date(Date.now() - STALE_QUEUED_MS) },
      },
    }).catch(() => ({ count: 0 }));

    void prisma.importQueue.findMany({
      where: {
        status: "running",
        startedAt: { lt: new Date(Date.now() - STALE_QUEUED_MS) },
      },
      select: { id: true, logId: true },
    }).then(async (staleRunning) => {
      for (const item of staleRunning) {
        if (item.logId) {
          const log = await prisma.importLog.findUnique({
            where: { id: item.logId },
            select: { lastProgressAt: true, startedAt: true },
          }).catch(() => null);
          const lastActivity = log?.lastProgressAt || log?.startedAt;
          if (lastActivity && (Date.now() - lastActivity.getTime()) < STALE_PROGRESS_MS) {
            continue;
          }
        }
        await prisma.importQueue.update({
          where: { id: item.id },
          data: { status: "failed", finishedAt: new Date() },
        }).catch(() => {});
        if (item.logId) {
          await prisma.importLog.update({
            where: { id: item.logId },
            data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: "systemError.timeout_no_progress", lineNumber: 0 }]) },
          }).catch(() => {});
        }
      }
      if (staleRunning.length > 0) {
        console.log(`[Scheduler] Limpiados ${staleRunning.length} items running stale`);
      }
    }).catch(() => {});

    // Clean orphan ImportLogs (status "running" with no matching queue item)
    void prisma.importLog.findMany({
      where: { status: "running", startedAt: { lt: new Date(Date.now() - STALE_QUEUED_MS) } },
      select: { id: true, configId: true, lastProgressAt: true, startedAt: true },
    }).then(async (orphanLogs) => {
      for (const log of orphanLogs) {
        const hasQueueItem = await prisma.importQueue.findFirst({
          where: { logId: log.id, status: { in: ["queued", "running"] } },
          select: { id: true },
        }).catch(() => null);
        if (!hasQueueItem) {
          const lastActivity = log.lastProgressAt || log.startedAt;
          if (lastActivity && (Date.now() - lastActivity.getTime()) < STALE_PROGRESS_MS) {
            continue;
          }
          await prisma.importLog.update({
            where: { id: log.id },
            data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: "systemError.timeout_orphan", lineNumber: 0 }]) },
          }).catch(() => {});
          console.log(`[Scheduler] Limpiado orphan ImportLog ${log.id.slice(0, 8)}`);
        }
      }
    }).catch(() => {});
  }, 60_000);

  void refreshSchedules().catch((error: any) =>
    console.error("[Scheduler] Error al inicializar:", error)
  );

  void resumeInterruptedJobs().catch((error: any) =>
    console.error("[Scheduler] Error al reanudar imports interrumpidos:", error)
  );
}

export async function refreshSchedules() {
  if (refreshing) return;
  refreshing = true;
  try {
    const configs = await prisma.importConfig.findMany({
      where: { isActive: true, planPaused: false },
    });

    console.log(`[Scheduler] refreshSchedules: ${configs.length} configs activos`);

    const activeIds = new Set(configs.map((c) => c.id));

    for (const [id] of timers) {
      if (!activeIds.has(id)) {
        clearTimeout(timers.get(id)!);
        timers.delete(id);
        scheduledFrequencies.delete(id);
        configStaggerOffset.delete(id);
        pendingRetries.delete(id);
      }
    }

    for (const config of configs) {
      if (!isUrlSource(config)) {
        if (timers.has(config.id)) {
          clearTimeout(timers.get(config.id)!);
          timers.delete(config.id);
          scheduledFrequencies.delete(config.id);
        }
        continue;
      }

      const freqMs = getFrequencyMs(config.frequency);
      if (!freqMs) {
        if (timers.has(config.id)) {
          clearTimeout(timers.get(config.id)!);
          timers.delete(config.id);
          scheduledFrequencies.delete(config.id);
        }
        continue;
      }

      if (isImportActive(config.id) || configLocks.has(config.id)) {
        continue;
      }

      const storedFreq = scheduledFrequencies.get(config.id);
      if (storedFreq === config.frequency && timers.has(config.id)) continue;

      if (storedFreq && storedFreq !== config.frequency) {
        console.log(`[Scheduler] Reprogramando ${config.name}: ${storedFreq} → ${config.frequency}`);
      }

      scheduledFrequencies.set(config.id, config.frequency);
      scheduleNext(config.id, config.frequency, config.lastImportAt);
      console.log(`[Scheduler] Programada ${config.name} → ${config.frequency}`);
    }
  } finally {
    refreshing = false;
  }
}

async function runScheduledImport(configId: string) {
  if (configLocks.has(configId)) {
    console.log(`[Scheduler] ${configId.slice(0, 8)} ya está en proceso, skip`);
    return;
  }
  configLocks.add(configId);

  try {
    pendingRetries.delete(configId);

    const activeQueueItem = await prisma.importQueue.findFirst({
      where: { configId, status: { in: ["queued", "running"] } },
      select: { id: true, status: true, startedAt: true, logId: true },
    }).catch(() => null);
    if (activeQueueItem) {
      if (activeQueueItem.status === "running" && activeQueueItem.logId) {
        const log = await prisma.importLog.findUnique({
          where: { id: activeQueueItem.logId },
          select: { lastProgressAt: true, startedAt: true },
        }).catch(() => null);
        const lastActivity = log?.lastProgressAt || log?.startedAt;
        if (lastActivity && (Date.now() - lastActivity.getTime()) > 15 * 60 * 1000) {
          console.log(`[Scheduler] ${configId.slice(0, 8)} running sin progreso (${Math.round((Date.now() - lastActivity.getTime()) / 60_000)}min), limpiando`);
          await prisma.importQueue.update({
            where: { id: activeQueueItem.id },
            data: { status: "failed", finishedAt: new Date() },
          }).catch(() => {});
          await prisma.importLog.update({
            where: { id: activeQueueItem.logId },
            data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: "systemError.timeout_no_progress", lineNumber: 0 }]) },
          }).catch(() => {});
        } else {
          console.log(`[Scheduler] ${configId.slice(0, 8)} ya tiene item en cola/running (${activeQueueItem.status}), skip`);
          scheduleNext(configId, scheduledFrequencies.get(configId) || "4h", null);
          return;
        }
      } else {
        console.log(`[Scheduler] ${configId.slice(0, 8)} ya tiene item en cola/running (${activeQueueItem.status}), skip`);
        scheduleNext(configId, scheduledFrequencies.get(configId) || "4h", null);
        return;
      }
    }

    const recentLog = await prisma.importLog.findFirst({
      where: { configId, status: { in: ["running", "completed", "completed_with_errors"] } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, completedAt: true, status: true },
    });
    if (recentLog) {
      const referenceTime = recentLog.completedAt || recentLog.startedAt;
      if (referenceTime) {
        const elapsed = Date.now() - referenceTime.getTime();
        if (elapsed < IMPORT_COOLDOWN_MS) {
          const remaining = IMPORT_COOLDOWN_MS - elapsed;
          console.log(`[Scheduler] ${configId.slice(0, 8)} importación reciente (${Math.round(elapsed / 1000)}s atrás), cooldown ${Math.round(remaining / 1000)}s`);
          scheduleNext(configId, scheduledFrequencies.get(configId) || "4h", null, remaining + 5_000);
          return;
        }
      }
    }

    const config = await prisma.importConfig.findUnique({ where: { id: configId } });

    if (!config || !config.isActive) {
      scheduleNext(configId, scheduledFrequencies.get(configId) || "4h", null);
      return;
    }

    if (config.planPaused) {
      console.log(`[Scheduler] ${config.name} pausado por límite de plan, skip`);
      scheduleNext(configId, scheduledFrequencies.get(configId) || "4h", null);
      return;
    }

    const subscription = await getSubscriptionInfo(config.shopDomain);
    if (!subscription.hasActiveSubscription && !subscription.isTrial) {
      console.log(`[Scheduler] ${config.name} sin suscripción activa, skip`);
      scheduleNext(configId, scheduledFrequencies.get(configId) || "4h", null);
      return;
    }

    if (subscription.isTrial && subscription.trialDaysRemaining <= 0) {
      console.log(`[Scheduler] ${config.name} trial expirado, ejecutando enforcePlanLimits`);
      await enforcePlanLimits(config.shopDomain);
      scheduleNext(configId, scheduledFrequencies.get(configId) || "4h", null);
      return;
    }

    if (!isUrlSource(config)) {
      scheduleNext(configId, scheduledFrequencies.get(configId) || "4h", null);
      return;
    }

    const sourceLabel = config.dataSource === "file"
      ? config.localFilePath?.split(/[/\\]/).pop() || "Archivo local"
      : config.csvUrl || "URL";

    console.log(`[Scheduler] ${config.name} encolando importación (${config.importMode})`);

    await enqueue({
      shopDomain: config.shopDomain,
      configId: config.id,
      supplierName: config.name,
      sourceLabel,
      triggerType: "scheduled",
      importMode: config.importMode,
      filterType: config.filterType || undefined,
      filterSkus: config.filterSkus || undefined,
      filterCategories: config.filterCategories || undefined,
    });

    scheduleNext(configId, config.frequency, new Date());
  } finally {
    configLocks.delete(configId);
  }
}

export function stopAllSchedulers() {
  for (const [id, timer] of timers) {
    clearTimeout(timer);
  }
  timers.clear();
  configLocks.clear();
  pendingRetries.clear();
  started = false;
}

export function getActiveSchedulerImports(): string[] {
  return [];
}

export function cancelScheduledImport(configId: string): boolean {
  return false;
}
