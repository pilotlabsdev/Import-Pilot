import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { prisma, getOrCreateConfig, getEffectiveUrl, getSourceKey } from "~/lib/db.server";
import { isExcluded, parseExcludeFieldRules, getExcludedFields } from "~/lib/csv-parser.server";
import { getCachedCsvRows } from "~/lib/csv-cache.server";
import { calculatePriceSync, getActivePriceRules } from "~/lib/price-rules.server";
import { getLocationId } from "~/lib/location.server";
import { authenticate } from "~/shopify.server";

type ShopifySkuData = { productId: string; variantId: string; inventoryItemId: string | null; stock: number; price: number; compareAtPrice: number; totalStock: number };

const shopifyCache = new Map<string, { data: Map<string, ShopifySkuData>; expiresAt: number }>();
const SHOPIFY_CACHE_TTL = 5 * 60 * 1000;

interface PreviewResultCache {
  items: any[];
  totalRows: number;
  filteredTotal: number;
  importFilteredTotal: number;
  stats: { creates: number; updates: number; unchanged: number; excluded: number } | null;
  timestamp: number;
}
const previewResultCache = new Map<string, PreviewResultCache>();
const PREVIEW_RESULT_TTL = 5 * 60 * 1000;

function getShopifyCache(shopDomain: string): Map<string, ShopifySkuData> | null {
  const entry = shopifyCache.get(shopDomain);
  if (entry && entry.expiresAt > Date.now()) {
    console.log(`[Preview] Using cached Shopify data for ${shopDomain} (${entry.data.size} SKUs)`);
    return entry.data;
  }
  if (entry) shopifyCache.delete(shopDomain);
  return null;
}

function setShopifyCache(shopDomain: string, data: Map<string, ShopifySkuData>): void {
  shopifyCache.set(shopDomain, { data, expiresAt: Date.now() + SHOPIFY_CACHE_TTL });
}

async function fetchShopifySkusByBatch(
  admin: any,
  locationId: string,
  skuList: string[]
): Promise<Map<string, ShopifySkuData>> {
  const map = new Map<string, ShopifySkuData>();
  const BATCH_SIZE = 50;

  for (let i = 0; i < skuList.length; i += BATCH_SIZE) {
    const batch = skuList.slice(i, i + BATCH_SIZE);
    const query = batch.map((sku) => `sku:${JSON.stringify(sku)}`).join(" OR ");

    try {
      let cursor: string | null = null;
      let hasMore = true;

      while (hasMore) {
        const variables: any = { query, first: 250, locationId };
        if (cursor) variables.after = cursor;

        const res: Response = await admin.graphql(
          `#graphql
          query SkuSearch($query: String!, $first: Int!, $after: String, $locationId: ID!) {
            productVariants(first: $first, after: $after, query: $query) {
              edges {
                node {
                  id
                  sku
                  price
                  compareAtPrice
                  inventoryQuantity
                  product { id }
                  inventoryItem {
                    id
                    inventoryLevel(locationId: $locationId) {
                      quantities(names: ["available"]) {
                        name
                        quantity
                      }
                    }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { variables }
        );
        const json: any = await res.json();
        if (json.errors) {
          console.error(`[Preview] GraphQL errors:`, JSON.stringify(json.errors).substring(0, 500));
        }
        const edges = json.data?.productVariants?.edges || [];
        if (i === 0 && edges.length > 0) {
          const sample = edges[0].node;
          console.log(`[Preview] Sample variant: sku=${sample.sku}, price=${sample.price}, inventoryItem.id=${sample.inventoryItem?.id}, inventoryLevel=${JSON.stringify(sample.inventoryItem?.inventoryLevel)}, locationId=${locationId}`);
        }

        for (const edge of edges) {
          const v = edge.node;
          if (v.sku) {
            const availQty = v.inventoryItem?.inventoryLevel?.quantities?.find((q: any) => q.name === "available");
            map.set(v.sku.toLowerCase(), {
              productId: v.product?.id || "",
              variantId: v.id,
              inventoryItemId: v.inventoryItem?.id ?? null,
              stock: availQty?.quantity ?? 0,
              price: parseFloat(v.price || "0"),
              compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice) : 0,
              totalStock: v.inventoryQuantity ?? 0,
            });
          }
        }

        hasMore = json.data?.productVariants?.pageInfo?.hasNextPage ?? false;
        cursor = hasMore ? json.data.productVariants.pageInfo.endCursor : null;
      }
    } catch (e: any) {
      console.error(`[Preview] Error in SKU batch ${Math.floor(i / BATCH_SIZE) + 1}:`, e?.message);
    }
  }

  return map;
}

async function fetchAllShopifySkus(
  admin: any,
  locationId: string,
  shopDomain: string,
  csvSkus: string[]
): Promise<Map<string, ShopifySkuData>> {
  const cached = getShopifyCache(shopDomain);
  if (cached) return cached;

  const startTime = Date.now();
  let result: Map<string, ShopifySkuData>;

  if (csvSkus.length > 0) {
    console.log(`[Preview] Fetching ${csvSkus.length} SKUs from Shopify by batch...`);
    result = await fetchShopifySkusByBatch(admin, locationId, csvSkus);
  } else {
    console.log(`[Preview] No CSV SKUs, falling back to full product scan...`);
    result = await fetchFullProductScan(admin, locationId);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Preview] Shopify fetch complete: ${result.size} SKUs found in ${elapsed}s`);
  setShopifyCache(shopDomain, result);
  return result;
}

async function fetchFullProductScan(
  admin: any,
  locationId: string
): Promise<Map<string, ShopifySkuData>> {
  const map = new Map<string, ShopifySkuData>();
  let cursor: string | null = null;
  let page = 0;

  do {
    page++;
    try {
      const res: Response = await admin.graphql(
        `#graphql
        query AllProducts($first: Int!, $after: String, $locationId: ID!) {
          products(first: $first, after: $after) {
            edges {
              node {
                id
                variants(first: 250) {
                  edges {
                    node {
                      id
                      sku
                      price
                      compareAtPrice
                      inventoryQuantity
                      inventoryItem {
                        id
                        inventoryLevel(locationId: $locationId) {
                          quantities(names: ["available"]) {
                            name
                            quantity
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { variables: { first: 250, after: cursor, locationId } }
      );
      const json: any = await res.json();
      const edges = json.data?.products?.edges || [];
      for (const edge of edges) {
        const product = edge.node;
        for (const vEdge of product.variants?.edges || []) {
          const v = vEdge.node;
          if (v.sku) {
            const availQty = v.inventoryItem?.inventoryLevel?.quantities?.find((q: any) => q.name === "available");
            map.set(v.sku.toLowerCase(), {
              productId: product.id,
              variantId: v.id,
              inventoryItemId: v.inventoryItem?.id ?? null,
              stock: availQty?.quantity ?? 0,
              price: parseFloat(v.price || "0"),
              compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice) : 0,
              totalStock: v.inventoryQuantity ?? 0,
            });
          }
        }
      }
      cursor = json.data?.products?.pageInfo?.hasNextPage
        ? json.data.products.pageInfo.endCursor
        : null;
    } catch (e: any) {
      console.error(`[Preview] Error fetching products page ${page}:`, e?.message);
      break;
    }
  } while (cursor);

  return map;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const shopDomain = session.shop;
    const url = new URL(request.url);
    const page = Math.max(parseInt(url.searchParams.get("page") || "1"), 1);
    const perPage = Math.min(parseInt(url.searchParams.get("perPage") || "50"), 5000);
    const filterSkus = url.searchParams.get("filterSkus") || "";
    const filterCategories = url.searchParams.get("filterCategories") || "";
    const configIdParam = url.searchParams.get("configId") || "";

    if (!shopDomain) return data({ preview: [], totalRows: 0, filteredTotal: 0, stats: { creates: 0, updates: 0, unchanged: 0, excluded: 0 }, page, perPage, error: "shop required" });

    let config;
    if (configIdParam) {
      config = await prisma.importConfig.findUnique({
        where: { id: configIdParam },
        include: { categoryMaps: true },
      });
    } else {
      const baseConfig = await getOrCreateConfig(shopDomain);
      config = await prisma.importConfig.findUnique({
        where: { id: baseConfig.id },
        include: { categoryMaps: true },
      });
    }

    if (!config || !getEffectiveUrl(config)) return data({ preview: [], totalRows: 0, filteredTotal: 0, stats: { creates: 0, updates: 0, unchanged: 0, excluded: 0 }, page, perPage, error: "No hay configuración" });

    const sourceKey = getSourceKey(config);
    const columnMaps = (await prisma.columnMapping.findMany({
      where: { configId: config.id, sourceKey },
    })).map((cm) => ({
      shopifyField: cm.shopifyField,
      csvColumn: cm.csvColumn,
      defaultValue: cm.defaultValue,
    }));

    const getField = (row: Record<string, string | undefined>, field: string) => {
      const m = columnMaps.find((c) => c.shopifyField === field);
      if (!m || !m.csvColumn) return m?.defaultValue || "";
      return row[m.csvColumn] || m.defaultValue || "";
    };

    const computeStats = url.searchParams.get("computeStats") !== "0";

    const start = (page - 1) * perPage;

    const skuSet = filterSkus
      ? new Set(filterSkus.split(",").map((s) => s.trim().toLowerCase()))
      : null;
    const catSet = filterCategories
      ? new Set(filterCategories.split(",").map((s) => s.trim().toLowerCase()))
      : null;
    const hasAnyPreviewFilter = skuSet !== null || catSet !== null;

    const importFilterSkus = config.filterSkus || "";
    const importFilterCategories = config.filterCategories || "";
    const importSkuSet = importFilterSkus
      ? new Set(importFilterSkus.split(",").map((s) => s.trim().toLowerCase()))
      : null;
    const importCatSet = importFilterCategories
      ? new Set(importFilterCategories.split(",").map((s) => s.trim().toLowerCase()))
      : null;
    const hasAnyImportFilter = importSkuSet !== null || importCatSet !== null;
    const fieldRules = parseExcludeFieldRules(config.excludeFieldRules);
    const effectiveUrl = getEffectiveUrl(config)!;

    let totalRows = 0;
    let filteredTotal = 0;
    let importFilteredTotal = 0;
    let creates = 0;
    let updates = 0;
    let unchanged = 0;
    let excluded = 0;
    const seenSkusForImport = new Set<string>();
    const pageItems: any[] = [];

    const streamStart = Date.now();
    const { rows: csvRows } = await getCachedCsvRows(config.id, effectiveUrl, config.csvDelimiter);
    const streamTime = ((Date.now() - streamStart) / 1000).toFixed(1);
    console.log(`[Preview] Got ${csvRows.length} cached rows in ${streamTime}s`);

    let filteredCount = 0;
    const allFilteredSkus = new Set<string>();

    for (const row of csvRows) {
      totalRows++;

      const sku = getField(row, "sku") || row["sku"] || "";
      if (!sku) continue;

      const category = getField(row, "category");
      const ean = getField(row, "ean") || row["ean"] || "";
      const skuLower = sku.toLowerCase();
      const catLower = category.toLowerCase();

      const passesPreviewFilter = !hasAnyPreviewFilter || (skuSet?.has(skuLower) ?? false) || (catSet?.has(catLower) ?? false);
      const passesImportFilter = !hasAnyImportFilter || (importSkuSet?.has(skuLower) ?? false) || (importCatSet?.has(catLower) ?? false);

      if (passesImportFilter && !seenSkusForImport.has(skuLower)) {
        seenSkusForImport.add(skuLower);
        importFilteredTotal++;
      }

      if (!passesPreviewFilter) continue;
      filteredTotal++;
      filteredCount++;
      allFilteredSkus.add(skuLower);

      if (filteredCount <= start || filteredCount > start + perPage) continue;

      const exclusion = isExcluded(row, columnMaps, config!, (r, _m, field) => {
        const m = columnMaps.find((c) => c.shopifyField === field);
        if (!m || !m.csvColumn) return m?.defaultValue || "";
        return r[m.csvColumn] || m.defaultValue || "";
      }, { sku, ean });

      pageItems.push({ row, sku, skuLower, category, ean, exclusion });
    }

    const pageSkus = new Set(pageItems.map((p) => p.skuLower));
    const skusToFetch = computeStats ? [...allFilteredSkus] : [...pageSkus];
    console.log(`[Preview] Filtered ${filteredTotal} rows, ${pageItems.length} on page, fetching Shopify for ${skusToFetch.length} SKUs (stats=${computeStats})`);

    let shopifySkus: Map<string, ShopifySkuData> = new Map();
    try {
      const locationId = await getLocationId(admin, shopDomain, config.id);
      shopifySkus = await fetchAllShopifySkus(admin, locationId, shopDomain, skusToFetch);
    } catch (e: any) {
      console.error("[Preview] Error fetching Shopify products:", e?.message);
    }

    const priceRules = await getActivePriceRules(shopDomain, config.id);

    if (computeStats) {
      const importSeenSkus = new Set<string>();
      for (const row of csvRows) {
        const sku = getField(row, "sku") || row["sku"] || "";
        if (!sku) continue;
        const skuLower = sku.toLowerCase();
        const category = getField(row, "category");
        const ean = getField(row, "ean") || row["ean"] || "";

        const passesImportFilter = !hasAnyImportFilter || (importSkuSet?.has(skuLower) ?? false) || (importCatSet?.has(category.toLowerCase()) ?? false);
        if (!passesImportFilter || importSeenSkus.has(skuLower)) continue;
        importSeenSkus.add(skuLower);

        const exclusion = isExcluded(row, columnMaps, config!, (r, _m, field) => {
          const m = columnMaps.find((c) => c.shopifyField === field);
          if (!m || !m.csvColumn) return m?.defaultValue || "";
          return r[m.csvColumn] || m.defaultValue || "";
        }, { sku, ean });

        const csvQuantityStat = parseInt((getField(row, "quantity") || "0").replace(",", "."));
        const foundInShopifyStat = shopifySkus.has(skuLower);
        const isSkipStock = config.skipZeroStockCreate && !foundInShopifyStat && csvQuantityStat <= 0;
        const isNotImportable = exclusion.excluded || isSkipStock;

        if (isNotImportable) {
          excluded++;
        } else if (!foundInShopifyStat) {
          creates++;
        } else {
          const shopifyData = shopifySkus.get(skuLower)!;
          const costPriceStat = parseFloat((getField(row, "price") || "0").replace(",", "."));
          let pricesStat;
          try {
            pricesStat = calculatePriceSync(priceRules, sku, category, costPriceStat);
          } catch {
            pricesStat = { regularPrice: costPriceStat, compareAtPrice: 0 };
          }
          const priceChanged = Math.abs(pricesStat.regularPrice - shopifyData.price) > 0.001;
          const compareChanged = Math.abs((pricesStat.compareAtPrice ?? 0) - shopifyData.compareAtPrice) > 0.001;
          const stockChanged = csvQuantityStat !== shopifyData.stock;
          if (priceChanged || compareChanged || stockChanged) {
            updates++;
          } else {
            unchanged++;
          }
        }
      }
    }

    const builtPageItems: any[] = [];
    for (const { row, sku, skuLower, category, ean, exclusion } of pageItems) {
      const getFieldVal = (field: string) => getField(row, field);
      const costPrice = parseFloat((getFieldVal("price") || "0").replace(",", "."));
      const csvQuantity = parseInt((getFieldVal("quantity") || "0").replace(",", "."));
      const stockFromCsv = csvQuantity;

      let prices;
      try {
        prices = calculatePriceSync(priceRules, sku, category, costPrice);
      } catch (priceErr: any) {
        prices = { regularPrice: costPrice, compareAtPrice: 0 };
      }

      const foundInShopify = shopifySkus.has(skuLower);
      const shopifyData = foundInShopify ? shopifySkus.get(skuLower)! : null;

      let action: "create" | "update" | "unchanged" | "excluded" = "create";
      if (exclusion.excluded) {
        action = "excluded";
      } else if (foundInShopify) {
        const priceChanged = Math.abs(prices.regularPrice - (shopifyData?.price || 0)) > 0.001;
        const compareChanged = Math.abs((prices.compareAtPrice ?? 0) - (shopifyData?.compareAtPrice || 0)) > 0.001;
        const stockChanged = csvQuantity !== (shopifyData?.stock || 0);
        action = (priceChanged || compareChanged || stockChanged) ? "update" : "unchanged";
      }

      const skipForStock = config.skipZeroStockCreate && action === "create" && csvQuantity <= 0;

      const categoryMap = config.categoryMaps.filter(
        (cm) => cm.csvCategory === category && cm.isActive
      );
      const collectionNames = categoryMap.map((cm) => cm.collectionName);

      const errors: string[] = [];
      if (!getFieldVal("title")) errors.push("Sin nombre");
      if (costPrice <= 0) errors.push("Precio proveedor inválido");
      if (exclusion.excluded) errors.push(`Excluido: ${exclusion.reason}`);
      if (csvQuantity <= 0 && config.skipZeroStockCreate) errors.push("Skip stock 0");

      const excludedFields = getExcludedFields(sku, fieldRules);
      if (excludedFields) {
        if (excludedFields.includes("price")) errors.push("Regla: sin actualización precio");
        if (excludedFields.includes("stock")) errors.push("Regla: sin actualización stock");
      }

      builtPageItems.push({
        sku,
        ean,
        name: getFieldVal("title") || "Sin nombre",
        action: exclusion.excluded ? "excluded" : skipForStock ? "skip" : action,
        costPrice,
        regularPrice: prices.regularPrice,
        compareAtPrice: prices.compareAtPrice,
        shopifyPrice: shopifyData?.price ?? null,
        shopifyCompareAtPrice: shopifyData?.compareAtPrice ?? null,
        stockFromCsv,
        shopifyStock: shopifyData?.stock ?? 0,
        totalStock: shopifyData?.totalStock ?? 0,
        category,
        collections: collectionNames,
        errors,
      });
    }

    return data({
      preview: builtPageItems,
      totalRows,
      filteredTotal,
      importFilteredTotal,
      stats: computeStats ? { creates, updates, unchanged, excluded } : null,
      statsAvailable: computeStats,
      page,
      perPage,
    });
  } catch (e: any) {
    const errMsg = e instanceof Response
      ? `Error ${e.status}: ${e.statusText || "Error del servidor"}`
      : (e?.message || String(e) || "Error desconocido");
    console.error("[Preview] Loader error:", errMsg);
    return data({
      preview: [],
      totalRows: 0,
      filteredTotal: 0,
      stats: { creates: 0, updates: 0, unchanged: 0, excluded: 0 },
      page: 1,
      perPage: 50,
      error: errMsg,
    });
  }
};
