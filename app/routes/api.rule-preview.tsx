import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { prisma, getConfigById, getEffectiveUrl, getSourceKey } from "~/lib/db.server";
import { streamFile } from "~/lib/csv-parser.server";
import { calculatePrices } from "~/lib/price-rules.server";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const url = new URL(request.url);
  const configIdParam = url.searchParams.get("configId") || "";
  const ruleId = url.searchParams.get("ruleId") || "";
  const mappingId = url.searchParams.get("mappingId") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 1000);
  const scanLimitParam = parseInt(url.searchParams.get("scanLimit") || "0");
  const scanLimit = scanLimitParam > 0 ? Math.min(scanLimitParam, 250000) : Infinity;

  if (!configIdParam) return data({ error: "configId requerido" }, { status: 400 });

  const config = await getConfigById(configIdParam);
  if (!config || config.shopDomain !== shopDomain) return data({ error: "No encontrado" }, { status: 404 });
  if (!getEffectiveUrl(config)) return data({ error: "Sin archivo CSV" }, { status: 400 });

  const sourceKey = getSourceKey(config);
  const columnMaps = (
    await prisma.columnMapping.findMany({ where: { configId: config.id, sourceKey } })
  ).map((cm) => ({ shopifyField: cm.shopifyField, csvColumn: cm.csvColumn, defaultValue: cm.defaultValue }));

  const getField = (row: Record<string, string | undefined>, field: string) => {
    const m = (columnMaps || []).find((c: any) => c.shopifyField === field);
    if (!m || !m.csvColumn) return m?.defaultValue || "";
    return row[m.csvColumn] || m.defaultValue || "";
  };

  if (ruleId) {
    const rule = await prisma.priceRule.findUnique({ where: { id: ruleId } });
    if (!rule || rule.configId !== config.id) return data({ error: "Regla no encontrada" }, { status: 404 });

    const items: any[] = [];
    let count = 0;
    let scanned = 0;

    for await (const item of streamFile(getEffectiveUrl(config), config.csvDelimiter)) {
      if (items.length >= limit || (scanLimit !== Infinity && scanned >= scanLimit)) break;
      scanned++;
      const { row } = item;
      const sku = row["sku"] || "";
      if (!sku) continue;

      const category = getField(row, "category");
      const skuLower = sku.toLowerCase();

      let matchesRule = false;
      if (rule.ruleType === "general") {
        matchesRule = true;
      } else if (rule.ruleType === "category" && rule.targetValue) {
        try {
          const targets: string[] = JSON.parse(rule.targetValue);
          matchesRule = targets.some((t) => category.toLowerCase() === t.toLowerCase());
        } catch { matchesRule = false; }
      } else if (rule.ruleType === "product" && rule.targetValue) {
        try {
          const targets: string[] = JSON.parse(rule.targetValue);
          matchesRule = targets.some((t) => skuLower === t.toLowerCase());
        } catch { matchesRule = false; }
      }

      if (!matchesRule) continue;

      const costPrice = parseFloat((getField(row, "price") || "0").replace(",", "."));
      if (costPrice <= 0) continue;

      const prices = await calculatePrices(shopDomain, sku, category, costPrice, config.id);

      items.push({
        sku,
        name: getField(row, "title") || "Sin nombre",
        category,
        costPrice,
        regularPrice: prices.regularPrice,
        compareAtPrice: prices.compareAtPrice,
      });
      count++;
    }

    return data({ items, total: count, scanned, ruleName: rule.name, ruleType: rule.ruleType });
  }

  if (mappingId) {
    const mapping = await prisma.categoryCollectionMapping.findUnique({ where: { id: mappingId } });
    if (!mapping || mapping.configId !== config.id) return data({ error: "Mapeo no encontrado" }, { status: 404 });

    const items: any[] = [];
    let count = 0;
    let scanned = 0;

    for await (const item of streamFile(getEffectiveUrl(config), config.csvDelimiter)) {
      if (items.length >= limit || (scanLimit !== Infinity && scanned >= scanLimit)) break;
      scanned++;
      const { row } = item;
      const category = getField(row, "category");
      if (category.trim().toLowerCase() !== mapping.csvCategory.trim().toLowerCase()) continue;

      const sku = row["sku"] || "";
      items.push({
        sku: sku || "—",
        name: getField(row, "title") || "Sin nombre",
        category,
        collection: mapping.collectionName,
      });
      count++;
    }

    return data({ items, total: count, scanned, csvCategory: mapping.csvCategory, collectionName: mapping.collectionName });
  }

  return data({ error: "Se necesita ruleId o mappingId" }, { status: 400 });
};
