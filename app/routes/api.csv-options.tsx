import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { prisma, getOrCreateConfig, getEffectiveUrl, getSourceKey } from "~/lib/db.server";
import { fetchCSVSkus, fetchCSVCategories, fetchCSVBrands, fetchCSVHeaders } from "~/lib/csv-parser.server";
import { getCachedCategories, getCachedBrands, getCachedSkus, getCachedHeaders } from "~/lib/csv-cache.server";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "";
  const configIdParam = url.searchParams.get("configId") || "";
  const type = url.searchParams.get("type") || "sku";
  const search = url.searchParams.get("q") || undefined;
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 5000);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0"), 0);
  const selectedParam = url.searchParams.get("selected") || "";
  const selectedValues = selectedParam ? selectedParam.split(",").filter(Boolean) : [];

  if (!shopDomain) {
    return data({ options: [], total: 0, offset, limit, error: "shop required" });
  }

  let config;
  if (configIdParam) {
    config = await prisma.importConfig.findUnique({
      where: { id: configIdParam },
    });
  } else {
    const baseConfig = await getOrCreateConfig(shopDomain);
    config = await prisma.importConfig.findUnique({
      where: { id: baseConfig.id },
    });
  }
  if (!config || config.shopDomain !== shopDomain) {
    return data({ options: [], total: 0, offset, limit, error: "Proveedor no encontrado" });
  }
  if (!getEffectiveUrl(config)) {
    return data({ options: [], total: 0, offset, limit, error: "CSV URL not configured" });
  }

  console.log(`[api.csv-options] configId=${config.id}, type=${type}, effectiveUrl=${getEffectiveUrl(config)?.substring(0, 60)}`);
  try {
    const effectiveUrl = getEffectiveUrl(config);
    if (type === "headers") {
      const headers = await getCachedHeaders(config.id, effectiveUrl, config.csvDelimiter || "auto");
      return data({ headers, total: headers.length });
    }

    const sourceKey = getSourceKey(config);
    const columnMaps = await prisma.columnMapping.findMany({
      where: { configId: config.id, sourceKey },
    });

    if (type === "category") {
      const catMapping = columnMaps.find((cm) => cm.shopifyField === "category");
      const catColumn = catMapping?.csvColumn?.toLowerCase() || "category";
      const allCategories = await getCachedCategories(
        config.id,
        effectiveUrl,
        config.csvDelimiter || "auto",
        catColumn
      );
      const filtered = search
        ? allCategories.filter((c) => c.toLowerCase().includes(search.toLowerCase()))
        : allCategories;

      const selectedItems = filtered.filter((c) => selectedValues.includes(c));
      const unselectedItems = filtered.filter((c) => !selectedValues.includes(c));
      const sorted = [...selectedItems, ...unselectedItems];

      const options = sorted.slice(offset, offset + limit).map((c) => ({ value: c, label: c }));
      return data({ options, total: filtered.length, offset, limit });
    }

    if (type === "brand") {
      const brandMapping = columnMaps.find((cm) => cm.shopifyField === "brand");
      const brandColumn = brandMapping?.csvColumn?.toLowerCase() || "brand";
      const allBrands = await getCachedBrands(
        config.id,
        effectiveUrl,
        config.csvDelimiter || "auto",
        brandColumn
      );
      const filtered = search
        ? allBrands.filter((b) => b.toLowerCase().includes(search.toLowerCase()))
        : allBrands;

      const selectedItems = filtered.filter((b) => selectedValues.includes(b));
      const unselectedItems = filtered.filter((b) => !selectedValues.includes(b));
      const sorted = [...selectedItems, ...unselectedItems];

      const options = sorted.slice(offset, offset + limit).map((b) => ({ value: b, label: b }));
      return data({ options, total: filtered.length, offset, limit });
    }

    const skuMapping = columnMaps.find((cm) => cm.shopifyField === "sku");
    const titleMapping = columnMaps.find((cm) => cm.shopifyField === "title");
    const eanMapping = columnMaps.find((cm) => cm.shopifyField === "ean");
    const skuColumn = skuMapping?.csvColumn?.toLowerCase() || "sku";
    const titleColumn = titleMapping?.csvColumn?.toLowerCase() || "name";
    const eanColumn = eanMapping?.csvColumn?.toLowerCase() || "ean";

    const allSkus = await getCachedSkus(
      config.id,
      effectiveUrl,
      config.csvDelimiter || "auto",
      skuColumn,
      titleColumn,
      undefined,
      eanColumn
    );

    const searchFiltered = search
      ? allSkus.filter((s) => {
          const sl = search.toLowerCase();
          return s.value.toLowerCase().includes(sl) || s.label.toLowerCase().includes(sl) || (s.ean && s.ean.toLowerCase().includes(sl));
        })
      : allSkus;

    const selectedItems = searchFiltered.filter((s) => selectedValues.includes(s.value));
    const unselectedItems = searchFiltered.filter((s) => !selectedValues.includes(s.value));
    const sorted = [...selectedItems, ...unselectedItems];

    const sliced = sorted.slice(offset, offset + limit);
    return data({
      options: sliced,
      total: searchFiltered.length,
      offset,
      limit,
    });
  } catch (e: any) {
    console.error("[api.csv-options] Error:", e.message);
    return data({ options: [], total: 0, offset, limit, error: e.message });
  }
};
