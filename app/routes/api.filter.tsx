import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { prisma, getOrCreateConfig } from "~/lib/db.server";
import { authenticate } from "~/shopify.server";
import { refreshSchedules } from "~/lib/scheduler.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "";
  const configIdParam = url.searchParams.get("configId") || "";
  if (!shopDomain) return data({ filterType: "all", filterSkus: "", filterCategories: "" });

  let config;
  if (configIdParam) {
    config = await prisma.importConfig.findUnique({
      where: { id: configIdParam },
      select: { filterType: true, filterSkus: true, filterCategories: true },
    });
  } else {
    const baseConfig = await getOrCreateConfig(shopDomain);
    config = await prisma.importConfig.findUnique({
      where: { id: baseConfig.id },
      select: { filterType: true, filterSkus: true, filterCategories: true },
    });
  }

  return data({
    filterType: config?.filterType || "all",
    filterSkus: config?.filterSkus || "",
    filterCategories: config?.filterCategories || "",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const shopDomain = formData.get("shop") as string;
  const configIdParam = formData.get("configId") as string || "";
  if (!shopDomain) return data({ error: "shop required" });

  const updateData: Record<string, any> = {};

  // Only update filter fields if explicitly provided (not from cron toggle)
  if (formData.has("filterType")) updateData.filterType = formData.get("filterType") as string || "all";
  if (formData.has("filterSkus")) updateData.filterSkus = formData.get("filterSkus") as string || "";
  if (formData.has("filterCategories")) updateData.filterCategories = formData.get("filterCategories") as string || "";

  const isActiveStr = formData.get("isActive") as string;
  const isActive = isActiveStr !== null ? isActiveStr === "true" : undefined;
  if (isActive !== undefined) updateData.isActive = isActive;

  if (Object.keys(updateData).length === 0) return data({ success: true });

  let existingConfig;
  if (configIdParam) {
    existingConfig = await prisma.importConfig.findUnique({ where: { id: configIdParam } });
  } else {
    existingConfig = await getOrCreateConfig(shopDomain);
  }
  await prisma.importConfig.update({
    where: { id: existingConfig!.id },
    data: updateData,
  });

  if (isActive !== undefined) {
    await refreshSchedules().catch(() => {});
  }

  return data({ success: true });
};
