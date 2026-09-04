import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { isImportActive } from "~/lib/import-locks.server";
import { prisma } from "~/lib/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const configId = url.searchParams.get("configId") || "";

  if (!configId) {
    return data({ error: "Falta configId" }, { status: 400 });
  }

  // Check in-memory lock (chunks mode)
  if (isImportActive(configId)) {
    return data({ active: true });
  }

  // Check for active BulkJob (bulk mode)
  const activeBulkJob = await prisma.bulkJob.findFirst({
    where: { configId, phase: { in: ["lookup", "mutations", "finalizing"] } },
    select: { id: true },
  }).catch(() => null);
  if (activeBulkJob) {
    return data({ active: true });
  }

  // Check for active ImportLog (chunks mode running)
  const activeLog = await prisma.importLog.findFirst({
    where: { configId, status: "running" },
    select: { id: true },
  }).catch(() => null);
  if (activeLog) {
    return data({ active: true });
  }

  // Check for queued items for this config
  const queuedItem = await prisma.importQueue.findFirst({
    where: { configId, status: { in: ["queued", "running"] } },
    select: { id: true },
  }).catch(() => null);
  if (queuedItem) {
    return data({ active: true });
  }

  return data({ active: false });
};
