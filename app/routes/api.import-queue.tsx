import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { getQueueStatus, cancelQueueItem, getQueueItemProgress, clearCompleted } from "~/lib/queue-manager.server";
import { cancelBulkImport } from "~/lib/bulk-import.server";
import { prisma } from "~/lib/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "";

  if (!shopDomain) {
    return data({ error: "Falta shop" }, { status: 400 });
  }

  const status = await getQueueStatus(shopDomain);

  // Get progress for active items
  const activeWithProgress = await Promise.all(
    status.active.map(async (item) => {
      const progress = await getQueueItemProgress(item.id);
      return { ...item, progress };
    })
  );

  return data({ ...status, active: activeWithProgress });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "";
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const itemId = formData.get("itemId") as string;
  const configId = formData.get("configId") as string;

  if (intent === "clear-completed") {
    const result = await clearCompleted(shopDomain);
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
      return data({ success: false, message: "No se encontró importación activa o en cola" });
    }
    await prisma.importQueue.updateMany({
      where: { configId, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    return data({ success: true, message: `${items.length} importación(es) cancelada(s)` });
  }

  if (intent === "cancel-bulk") {
    if (!configId || !shopDomain) {
      return data({ error: "Faltan parámetros" }, { status: 400 });
    }
    const result = await cancelBulkImport(configId, shopDomain);
    return data(result);
  }

  if (!shopDomain || !itemId) {
    return data({ error: "Faltan parámetros" }, { status: 400 });
  }

  if (intent === "cancel") {
    const result = await cancelQueueItem(itemId, shopDomain);
    return data(result);
  }

  return data({ error: "Intento no válido" }, { status: 400 });
};
