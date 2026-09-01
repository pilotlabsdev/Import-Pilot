import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { getQueueStatus, cancelQueueItem, getQueueItemProgress, clearCompleted } from "~/lib/queue-manager.server";
import { cancelBulkImport, forceCleanupStuckBulkJobs } from "~/lib/bulk-import.server";
import { prisma } from "~/lib/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "";

  if (!shopDomain) {
    return data({ error: "Falta shop" }, { status: 400 });
  }

  try {
    const status = await getQueueStatus(shopDomain);

    // Get progress for active items
    const activeWithProgress = await Promise.all(
      status.active.map(async (item) => {
        const progress = await getQueueItemProgress(item.id);
        return { ...item, progress };
      })
    );

    console.log(`[Queue API] Loader OK shop=${shopDomain}, active=${status.active.length}, queued=${status.queued.length}, schedulerActive=${status.schedulerActive.length}, recent=${status.recent.length}`);
    return data({ ...status, active: activeWithProgress });
  } catch (error: any) {
    console.error(`[Queue API] Loader FAILED shop=${shopDomain}:`, error?.message || error);
    return data({ error: error?.message || "Error desconocido" }, { status: 500 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "";
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const itemId = formData.get("itemId") as string;
  const configId = formData.get("configId") as string;

  console.log(`[Queue API] Action: intent=${intent}, shop=${shopDomain}, itemId=${itemId || "null"}, configId=${configId || "null"}`);

  if (intent === "clear-completed") {
    const result = await clearCompleted(shopDomain);
    console.log(`[Queue API] clear-completed result:`, result);
    return data(result);
  }

  if (intent === "cancel-scheduled") {
    if (!configId) {
      return data({ error: "Falta configId" }, { status: 400 });
    }
    const items = await prisma.importQueue.findMany({
      where: { configId, status: { in: ["queued", "running"] } },
    });
    await prisma.importQueue.updateMany({
      where: { configId, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    // Also cancel stuck ImportLogs (they appear in schedulerActive without queue items)
    const stuckLogs = await prisma.importLog.updateMany({
      where: { configId, status: "running" },
      data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: "Cancelado manualmente", lineNumber: 0 }]) },
    });
    console.log(`[Queue API] cancel-scheduled: cancelled ${items.length} queue items and ${stuckLogs.count} logs for configId=${configId}`);
    return data({ success: true, message: `${items.length} en cola, ${stuckLogs.count} logs cancelados` });
  }

  if (intent === "cancel-bulk") {
    if (!configId || !shopDomain) {
      return data({ error: "Faltan parámetros" }, { status: 400 });
    }
    console.log(`[Queue API] cancel-bulk: configId=${configId}, shop=${shopDomain}`);
    const result = await cancelBulkImport(configId, shopDomain);
    console.log(`[Queue API] cancel-bulk result:`, result);
    return data(result);
  }

  if (intent === "cancel-bulk-job") {
    const bulkJobId = formData.get("bulkJobId") as string;
    if (!bulkJobId || !shopDomain) {
      return data({ error: "Faltan parámetros (bulkJobId, shop)" }, { status: 400 });
    }
    console.log(`[Queue API] cancel-bulk-job: bulkJobId=${bulkJobId}, shop=${shopDomain}`);
    const job = await prisma.bulkJob.findUnique({ where: { id: bulkJobId } });
    if (!job) {
      return data({ success: false, message: "Job no encontrado" });
    }
    // Force mark as failed
    await prisma.bulkJobOp.updateMany({
      where: { jobId: job.id, status: { in: ["pending", "launched", "processing"] } },
      data: { status: "failed" },
    });
    await prisma.bulkJob.update({
      where: { id: job.id },
      data: { phase: "failed" },
    });
    const log = await prisma.importLog.findUnique({ where: { id: job.logId } });
    if (log && log.status === "running") {
      await prisma.importLog.update({
        where: { id: log.id },
        data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: "Cancelado manualmente", lineNumber: 0 }]) },
      });
    }
    console.log(`[Queue API] cancel-bulk-job: job ${bulkJobId} marked as failed`);
    return data({ success: true, message: "Job bulk cancelado" });
  }

  if (!shopDomain || !itemId) {
    console.log(`[Queue API] Missing params: shop=${shopDomain}, itemId=${itemId}`);
    return data({ error: "Faltan parámetros" }, { status: 400 });
  }

  if (intent === "cancel") {
    console.log(`[Queue API] cancel: itemId=${itemId}, shop=${shopDomain}`);
    const result = await cancelQueueItem(itemId, shopDomain);
    console.log(`[Queue API] cancel result:`, result);
    return data(result);
  }

  if (intent === "cancel-log") {
    const logId = formData.get("logId") as string;
    if (!logId) {
      return data({ error: "Falta logId" }, { status: 400 });
    }
    console.log(`[Queue API] cancel-log: logId=${logId}`);
    const log = await prisma.importLog.findUnique({ where: { id: logId } });
    if (!log) {
      return data({ success: false, message: "Log no encontrado" });
    }
    if (log.status === "running") {
      await prisma.importLog.update({
        where: { id: logId },
        data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: "Cancelado manualmente", lineNumber: 0 }]) },
      });
    }
    // Also cancel associated queue items
    await prisma.importQueue.updateMany({
      where: { logId },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    console.log(`[Queue API] cancel-log: log ${logId} marked as failed`);
    return data({ success: true, message: "Importación cancelada" });
  }

  if (intent === "force-cleanup") {
    console.log(`[Queue API] force-cleanup: shop=${shopDomain}`);
    const result = await forceCleanupStuckBulkJobs(shopDomain || undefined);
    console.log(`[Queue API] force-cleanup result:`, result);
    return data(result);
  }

  console.log(`[Queue API] Unknown intent: ${intent}`);
  return data({ error: "Intento no válido" }, { status: 400 });
};
