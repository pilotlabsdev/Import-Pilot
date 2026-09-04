import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";

import { prisma, getOrCreateConfig, getConfigById, getEffectiveUrl } from "~/lib/db.server";
import { authenticate, unauthenticated } from "~/shopify.server";
import { enqueue, processNext } from "~/lib/queue-manager.server";
import { isImportActive } from "~/lib/import-locks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "";
  const configIdParam = url.searchParams.get("configId") || "";
  const filterType = url.searchParams.get("filterType") || undefined;
  const filterSkus = url.searchParams.get("filterSkus") || undefined;
  const filterCategories = url.searchParams.get("filterCategories") || undefined;
  const forceUpdate = url.searchParams.get("forceUpdate") === "true";

  if (!shopDomain) {
    return data({ error: "Falta el parámetro shop" }, { status: 400 });
  }

  let admin: any;
  try {
    const ctx = await authenticate.admin(request);
    admin = ctx.admin;
  } catch {
    const ctx = await unauthenticated.admin(shopDomain);
    admin = ctx.admin;
  }

  try {
    let config;
    if (configIdParam) {
      config = await getConfigById(configIdParam);
    } else {
      config = await getOrCreateConfig(shopDomain);
    }
    if (!config) {
      return data({ error: "Proveedor no encontrado" }, { status: 404 });
    }

    if (config.planPaused) {
      return data({ error: "Este proveedor está deshabilitado por límite de plan. Sube de plan para reactivarlo." }, { status: 403 });
    }

    const isActive = isImportActive(config.id);

    // Also check for active BulkJob (bulk mode) and running ImportLogs
    const activeBulkJob = isActive ? null : await prisma.bulkJob.findFirst({
      where: { configId: config.id, phase: { in: ["lookup", "mutations", "finalizing"] } },
      select: { id: true },
    }).catch(() => null);
    const activeImportLog = isActive ? null : await prisma.importLog.findFirst({
      where: { configId: config.id, status: "running" },
      select: { id: true },
    }).catch(() => null);
    const activeQueueItem = isActive ? null : await prisma.importQueue.findFirst({
      where: { configId: config.id, status: { in: ["queued", "running"] } },
      select: { id: true },
    }).catch(() => null);

    const anyActive = isActive || !!activeBulkJob || !!activeImportLog || !!activeQueueItem;

    if (anyActive) {
      // Already running → enqueue
      const sourceLabel = config.dataSource === "file"
        ? config.localFilePath?.split(/[/\\]/).pop() || "Archivo local"
        : config.csvUrl || "URL";

      const item = await enqueue({
        shopDomain,
        configId: config.id,
        supplierName: config.name || undefined,
        sourceLabel,
        triggerType: "manual",
        importMode: config.importMode || "chunks",
        filterType,
        filterSkus,
        filterCategories,
        forceUpdate,
      });

      return data({
        success: true,
        queued: true,
        position: item.position,
        messageKey: "import.queuedMessage",
        messageParams: { position: String(item.position) },
      });
    }

    // Not running → start immediately via queue manager
    const sourceLabel = config.dataSource === "file"
      ? config.localFilePath?.split(/[/\\]/).pop() || "Archivo local"
      : config.csvUrl || "URL";

    const item = await enqueue({
      shopDomain,
      configId: config.id,
      supplierName: config.name || undefined,
      sourceLabel,
      triggerType: "manual",
      importMode: config.importMode || "chunks",
      filterType,
      filterSkus,
      filterCategories,
      forceUpdate,
    });

    return data({
      success: true,
      queued: false,
      message: "Importación iniciada. Consulta el Historial.",
    });
  } catch (error: any) {
    console.error(`[Import] Error en action de ${shopDomain}:`, error?.message);
    return data({ error: error?.message }, { status: 500 });
  }
};
