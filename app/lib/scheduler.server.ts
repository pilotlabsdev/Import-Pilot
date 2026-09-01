import { prisma, isUrlSource } from "./db.server";
import { enqueue } from "./queue-manager.server";
import { reconcileStaleBulkJobs, cleanupFinishedBulkJobs } from "./bulk-import.server";
import { reconcileAllShops } from "./reconciliation.server";
import { isImportActive } from "./import-locks.server";
import { getSubscriptionInfo, enforcePlanLimits } from "./billing.server";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const scheduledFrequencies = new Map<string, string>();
const pendingRetries = new Set<string>();
const IMPORT_COOLDOWN_MS = 600_000;
let started = false;
let refreshing = false;
let reconcileCounter = 0;
const RECONCILE_INTERVAL = 720;
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

export function startScheduler() {
  if (started) return;
  started = true;
  console.log("[Scheduler] Iniciando scheduler de importaciones...");

  setInterval(() => {
    void reconcileStaleBulkJobs().catch((error: any) =>
      console.error("[Scheduler] Error en reconciliación de bulk jobs:", error)
    );
    void cleanupFinishedBulkJobs().catch((error: any) =>
      console.error("[Scheduler] Error en limpieza de bulk jobs:", error)
    );
    reconcileCounter++;
    if (reconcileCounter >= RECONCILE_INTERVAL) {
      reconcileCounter = 0;
      void reconcileAllShops().catch((error: any) =>
        console.error("[Scheduler] Error en reconciliación de mappings huérfanos:", error)
      );
    }

    // Heartbeat: detect missed timers (e.g. after Windows sleep/hibernation)
    // IMPORTANT: Only reschedule if no recent import log exists (cooldown check)
    void prisma.importConfig.findMany({
      where: { isActive: true, planPaused: false },
      select: { id: true, name: true, frequency: true, lastImportAt: true, csvUrl: true, dataSource: true },
    }).then(async (configs) => {
      for (const config of configs) {
        if (timers.has(config.id) || config.dataSource === "file") continue;
        if (configLocks.has(config.id)) continue;

        const activeQueueItem = await prisma.importQueue.findFirst({
          where: { configId: config.id, status: { in: ["queued", "running"] } },
          select: { id: true, status: true, startedAt: true, logId: true },
        }).catch(() => null);
        if (activeQueueItem) {
          // If running for >10 minutes, it's stuck — clean it up
          if (activeQueueItem.status === "running" && activeQueueItem.startedAt) {
            const stuckMs = Date.now() - activeQueueItem.startedAt.getTime();
            if (stuckMs > 600_000) {
              console.log(`[Scheduler] Heartbeat: ${config.name} tiene item running stale (${Math.round(stuckMs / 60_000)}min), limpiando`);
              await prisma.importQueue.update({
                where: { id: activeQueueItem.id },
                data: { status: "failed", finishedAt: new Date() },
              }).catch(() => {});
              if (activeQueueItem.logId) {
                await prisma.importLog.update({
                  where: { id: activeQueueItem.logId },
                  data: { status: "failed", completedAt: new Date(), errorMessage: "Timeout: import stuck >10min" },
                }).catch(() => {});
              }
            } else {
              continue;
            }
          } else {
            continue;
          }
        }

        // Cooldown check: don't reschedule if there's a recent import
        const recentLog = await prisma.importLog.findFirst({
          where: { configId: config.id, status: { in: ["running", "completed", "completed_with_errors"] } },
          orderBy: { startedAt: "desc" },
          select: { completedAt: true, startedAt: true },
        }).catch(() => null);

        if (recentLog) {
          const ref = recentLog.completedAt || recentLog.startedAt;
          if (ref && (Date.now() - ref.getTime()) < IMPORT_COOLDOWN_MS) {
            // Recent import active or just finished — schedule from now, not from stale lastImportAt
            const remaining = IMPORT_COOLDOWN_MS - (Date.now() - ref.getTime());
            console.log(`[Scheduler] Heartbeat: ${config.name} importación reciente, reprogramando en ${Math.round(remaining / 1000)}s`);
            scheduleNext(config.id, config.frequency, null, Math.max(remaining + 5_000, 30_000));
            continue;
          }
        }

        console.log(`[Scheduler] Heartbeat: ${config.name} sin timer, reprogramando (${config.frequency})`);
        scheduleNext(config.id, config.frequency, config.lastImportAt);
      }

      const STALE_QUEUED_MS = 30 * 60 * 1000;
      const staleQueued = await prisma.importQueue.deleteMany({
        where: {
          status: "queued",
          createdAt: { lt: new Date(Date.now() - STALE_QUEUED_MS) },
        },
      }).catch(() => ({ count: 0 }));
      if (staleQueued.count > 0) {
        console.log(`[Scheduler] Heartbeat: limpiados ${staleQueued.count} items stale en cola`);
      }

      // Clean stale "running" queue items (stuck after process restart/crash)
      const STALE_RUNNING_MS = 10 * 60 * 1000;
      const staleRunningItems = await prisma.importQueue.findMany({
        where: {
          status: "running",
          startedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) },
        },
        select: { id: true, configId: true, logId: true },
      }).catch(() => []);
      if (staleRunningItems.length > 0) {
        console.log(`[Scheduler] Heartbeat: limpiando ${staleRunningItems.length} items running stale (>10min)`);
        for (const item of staleRunningItems) {
          await prisma.importQueue.update({
            where: { id: item.id },
            data: { status: "failed", finishedAt: new Date() },
          }).catch(() => {});
          if (item.logId) {
            await prisma.importLog.update({
              where: { id: item.logId },
              data: { status: "failed", completedAt: new Date(), errorMessage: "Timeout: import stuck >10min" },
            }).catch(() => {});
          }
        }
      }
    }).catch(() => {});
  }, 60_000);

  void refreshSchedules().catch((error: any) =>
    console.error("[Scheduler] Error al inicializar:", error)
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
      // If running for >10 minutes, it's stuck — clean it up
      if (activeQueueItem.status === "running" && activeQueueItem.startedAt) {
        const stuckMs = Date.now() - activeQueueItem.startedAt.getTime();
        if (stuckMs > 600_000) {
          console.log(`[Scheduler] ${configId.slice(0, 8)} tiene item running stale (${Math.round(stuckMs / 60_000)}min), limpiando`);
          await prisma.importQueue.update({
            where: { id: activeQueueItem.id },
            data: { status: "failed", finishedAt: new Date() },
          }).catch(() => {});
          if (activeQueueItem.logId) {
            await prisma.importLog.update({
              where: { id: activeQueueItem.logId },
              data: { status: "failed", completedAt: new Date(), errorMessage: "Timeout: import stuck >10min" },
            }).catch(() => {});
          }
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
