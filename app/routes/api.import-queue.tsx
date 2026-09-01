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
    if (items.length === 0) {
      console.log(`[Queue API] cancel-scheduled: no items found for configId=${configId}`);
      return data({ success: false, message: "No se encontró importación activa o en cola" });
    }
    await prisma.importQueue.updateMany({
      where: { configId, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    console.log(`[Queue API] cancel-scheduled: cancelled ${items.length} items for configId=${configId}`);
    return data({ success: true, message: `${items.length} importación(es) cancelada(s)` });
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

  if (intent === "force-cleanup") {
    console.log(`[Queue API] force-cleanup: shop=${shopDomain}`);
    const result = await forceCleanupStuckBulkJobs(shopDomain || undefined);
    console.log(`[Queue API] force-cleanup result:`, result);
    return data(result);
  }

  console.log(`[Queue API] Unknown intent: ${intent}`);
  return data({ error: "Intento no válido" }, { status: 400 });
};
