import { prisma, getOrCreateConfig, getEffectiveUrl, getSourceKey, cleanupOldLogs } from "./db.server";
import { streamFile, isExcluded, parseExcludeFieldRules, getExcludedFields } from "./csv-parser.server";
import { calculatePrices } from "./price-rules.server";
import { mapCsvRowToProductSet, parseUpdateOptions, getField } from "./product-mapper.server";
import { getLocationId } from "./location.server";
import { checkDuplicate, logExternalDuplicate } from "./duplicate-detection.server";
import { rateLimitedGraphql } from "./import-locks.server";
import { ensureMetafieldDefinitions } from "./metafield-definitions";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphqlWithRetry(admin: any, query: string, vars: any, maxRetries = 3): Promise<any> {
  return rateLimitedGraphql(admin, query, vars, maxRetries);
}

async function setInventoryQuantity(admin: any, inventoryItemId: string, locationId: string, quantity: number): Promise<void> {
  // 1. Activate location first
  try {
    await graphqlWithRetry(admin,
      `#graphql
      mutation inventoryBulkToggleActivation($inventoryItemId: ID!, $inventoryItemUpdates: [InventoryBulkToggleActivationInput!]!) {
        inventoryBulkToggleActivation(inventoryItemId: $inventoryItemId, inventoryItemUpdates: $inventoryItemUpdates) {
          inventoryLevels { id location { id name } }
          userErrors { field message }
        }
      }`,
      {
        inventoryItemId,
        inventoryItemUpdates: [{ locationId, activate: true }],
      }
    );
  } catch (e: any) {
    console.error("[Import] inventoryBulkToggleActivation error:", e?.message);
  }

  // 2. Set quantities after activation
  const idempotencyKey = `inv-set-${inventoryItemId}-${locationId}-${Date.now()}`;
  await graphqlWithRetry(admin,
    `#graphql
    mutation inventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) { userErrors { field message } }
    }`,
    {
      input: {
        name: "available",
        reason: "correction",
        quantities: [{
          inventoryItemId,
          locationId,
          quantity,
          changeFromQuantity: null,
        }],
      },
      idempotencyKey,
    }
  );
}

async function updateInventoryItem(admin: any, inventoryItemId: string, fields: Record<string, any>): Promise<void> {
  await graphqlWithRetry(admin,
    `#graphql
    mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem { id }
        userErrors { field message }
      }
    }`,
    {
      id: inventoryItemId,
      input: fields,
    }
  );
}

async function updateVariantSku(admin: any, productId: string, variantId: string, sku: string): Promise<void> {
  await graphqlWithRetry(admin,
    `#graphql
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id sku }
        userErrors { field message }
      }
    }`,
    {
      productId,
      variants: [{
        id: variantId,
        inventoryItem: { sku },
      }],
    }
  );
}

async function verifyProductExists(admin: any, shopifyProductId: string): Promise<boolean> {
  try {
    const res = await graphqlWithRetry(admin,
      `#graphql
      query { product(id: "${shopifyProductId}") { id } }`,
      {}
    );
    return !!res.data?.product?.id;
  } catch {
    return false;
  }
}

async function getCurrentStock(admin: any, inventoryItemId: string, locationId: string): Promise<number> {
  const res = await graphqlWithRetry(admin,
    `#graphql
    query getInventoryLevel($inventoryItemId: ID!, $locationId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
      }
    }`,
    { inventoryItemId, locationId }
  );
  return res.data?.inventoryItem?.inventoryLevel
    ?.quantities?.find((q: any) => q.name === "available")?.quantity ?? 0;
}

async function adjustStock(admin: any, inventoryItemId: string, locationId: string, targetQuantity: number, sku: string, maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const currentQuantity = await getCurrentStock(admin, inventoryItemId, locationId);
    const delta = targetQuantity - currentQuantity;

    if (delta === 0) {
      console.log(`[Import] Stock already correct for SKU ${sku}: ${currentQuantity}`);
      return;
    }

    const idempotencyKey = `inv-adj-${inventoryItemId}-${locationId}-${targetQuantity}-${Date.now()}`;
    const stockRes = await graphqlWithRetry(admin,
      `#graphql
      mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
        inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          inventoryAdjustmentGroup { id }
          userErrors { field message code }
        }
      }`,
      {
        input: {
          reason: "correction",
          name: "available",
          changes: [{
            inventoryItemId,
            locationId,
            delta,
            changeFromQuantity: currentQuantity,
          }],
        },
        idempotencyKey,
      }
    );

    if (stockRes.errors?.length) {
      console.error(`[Import] Stock GQL errors for SKU ${sku}:`, JSON.stringify(stockRes.errors));
    }

    const mutationData = stockRes.data?.inventoryAdjustQuantities;
    if (!mutationData) {
      console.error(`[Import] Stock mutation returned null data for SKU ${sku}`);
      return;
    }

    const stockErrors = mutationData.userErrors || [];
    const stale = stockErrors.find((e: any) => e.code === "CHANGE_FROM_QUANTITY_STALE");

    if (stale) {
      console.log(`[Import] Stock STALE for SKU ${sku} (attempt ${attempt}/${maxRetries}), retrying...`);
      await sleep(500);
      continue;
    }

    if (stockErrors.length) {
      console.error(`[Import] Stock errors for SKU ${sku}:`, JSON.stringify(stockErrors));
      return;
    }

    console.log(`[Import] Stock OK for SKU ${sku}: delta=${delta} (now ${targetQuantity})`);
    return;
  }
  console.error(`[Import] Stock failed after ${maxRetries} retries for SKU ${sku}`);
}

interface ImportResult {
  logId: string;
  totalProducts: number;
  created: number;
  updated: number;
  unchanged: number;
  excluded: number;
  priceChanges: number;
  stockChanges: number;
  errors: Array<{ sku: string; error: string; lineNumber: number }>;
  lastSku: string;
}

interface ImportOptions {
  shopDomain: string;
  admin: any;
  filterType?: string;
  filterSkus?: string;
  filterCategories?: string;
  signal?: AbortSignal;
  triggerType?: string;
  configId?: string;
  queueItemId?: string;
}

export async function runImport({ shopDomain, admin, filterType, filterSkus, filterCategories, signal, triggerType, configId, queueItemId }: ImportOptions): Promise<ImportResult> {
  let config;
  const sourceKey = getSourceKey(configId ? await prisma.importConfig.findUnique({ where: { id: configId } }) || {} : await getOrCreateConfig(shopDomain));
  if (configId) {
    config = await prisma.importConfig.findUnique({
      where: { id: configId },
      include: { categoryMaps: true },
    });
  } else {
    const baseConfig = await getOrCreateConfig(shopDomain);
    config = await prisma.importConfig.findUnique({
      where: { id: baseConfig.id },
      include: { categoryMaps: true },
    });
  }

  if (!config) throw new Error("No hay configuración de importación para esta tienda");

  const columnMaps = (await prisma.columnMapping.findMany({
    where: { configId: config.id, sourceKey },
  })).map((cm) => ({
    shopifyField: cm.shopifyField,
    csvColumn: cm.csvColumn,
    defaultValue: cm.defaultValue,
  }));

  await ensureMetafieldDefinitions(admin);

  // Diagnostic: verify inventory permissions
  try {
    const diagRes = await admin.graphql(`{ shop { name } }`);
    const diagJson = await diagRes.json();
    console.log(`[Import] Admin client OK for ${shopDomain}. Shop: ${diagJson.data?.shop?.name}. Errors: ${JSON.stringify(diagJson.errors || [])}`);
  } catch (e: any) {
    console.error(`[Import] Admin client DIAG failed for ${shopDomain}:`, e?.message);
  }

  const locationId = await getLocationId(admin, shopDomain, config.id);
  const updateOpts = parseUpdateOptions(config.updateOptions);

  const log = await prisma.importLog.create({
    data: {
      shopDomain,
      configId: config.id,
      status: "running",
      triggerType: triggerType || "scheduled",
    },
  });

  if (queueItemId) {
    await prisma.importQueue.update({
      where: { id: queueItemId },
      data: { logId: log.id },
    }).catch(() => {});
  }

  const result: ImportResult = {
    logId: log.id,
    totalProducts: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    excluded: 0,
    priceChanges: 0,
    stockChanges: 0,
    errors: [],
    lastSku: "",
  };

  const csvSkus: string[] = [];
  const skuSet = filterSkus
    ? new Set(filterSkus.split(",").map((s) => s.trim().toLowerCase()))
    : null;
  const catSet = filterCategories
    ? new Set(filterCategories.split(",").map((s) => s.trim().toLowerCase()))
    : null;
  const hasAnyFilter = skuSet !== null || catSet !== null;
  let excludedCount = 0;
  const fieldRules = parseExcludeFieldRules(config.excludeFieldRules);
  console.log(`[Import] Filtros: skuSet=${skuSet ? [...skuSet].join(",") : "none"}, catSet=${catSet ? [...catSet].join(",") : "none"}, hasAnyFilter=${hasAnyFilter}`);

  try {
    const chunks: Array<Array<{ headers: string[]; row: any; lineNumber: number }>> = [];
    let currentChunk: Array<{ headers: string[]; row: any; lineNumber: number }> = [];
    const seenSkus = new Set<string>();

    for await (const item of streamFile(getEffectiveUrl(config), config.csvDelimiter, 3, signal)) {
      const { row } = item;
      const rowSku = (getField(row, columnMaps, "sku") || row["sku"] || "").trim().toLowerCase();
      const rowCat = (getField(row, columnMaps, "category") || row["category"] || "").trim().toLowerCase();

      if (hasAnyFilter) {
        const skuMatch = skuSet?.has(rowSku) ?? false;
        const catMatch = catSet?.has(rowCat) ?? false;
        if (!skuMatch && !catMatch) continue;
      }

      if (seenSkus.has(rowSku)) continue;
      seenSkus.add(rowSku);

      const exclusion = isExcluded(row, columnMaps, config, getField, { sku: getField(row, columnMaps, "sku") || row["sku"] || "", ean: getField(row, columnMaps, "ean") || row["ean"] || "" });
      if (exclusion.excluded) {
        if (excludedCount < 5) console.log(`[Import] EXCLUIDO SKU=${rowSku}: ${exclusion.reason}`);
        excludedCount++;
        continue;
      }

      result.totalProducts++;
      currentChunk.push(item);

      if (currentChunk.length >= config.chunkSize) {
        chunks.push(currentChunk);
        currentChunk = [];
      }
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    let cancelled = false;
    let checkCounter = 0;
    const processedInventoryItems = new Set<string>();
    for (const chunk of chunks) {
      for (const item of chunk) {
        checkCounter++;
        // Check abort signal immediately, or check config every 5 products for cron
        if (signal?.aborted) {
          console.log(`[Import] Importación cancelada por usuario (check #${checkCounter})`);
          cancelled = true;
          break;
        }
        if (triggerType !== "manual" && checkCounter % 5 === 0) {
          const freshConfig = await prisma.importConfig.findUnique({ where: { id: config.id }, select: { isActive: true } });
          if (!freshConfig?.isActive) {
            console.log(`[Import] Importación cancelada (config desactivada, check #${checkCounter})`);
            cancelled = true;
            break;
          }
        }

        const { row, lineNumber } = item;
        const sku = (getField(row, columnMaps, "sku") || row["SKU"] || row["sku"] || "").trim();

        if (!sku) {
          result.errors.push({ sku: "UNKNOWN", error: "SKU vacío", lineNumber });
          continue;
        }

        csvSkus.push(sku);
        result.lastSku = sku;

        try {
          const excludedFields = getExcludedFields(sku, fieldRules);
          const effectiveOpts = excludedFields
            ? new Set([...updateOpts].filter((o) => !excludedFields.includes(o)))
            : updateOpts;
          await processProduct({
            shopDomain,
            admin,
            sku,
            row,
            lineNumber,
            config,
            columnMaps,
            locationId,
            updateOpts: effectiveOpts,
            result,
            processedInventoryItems,
          });
        } catch (error: any) {
          const errorMsg = error?.message || "Error desconocido";
          let retried = false;

          for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const excludedFields = getExcludedFields(sku, fieldRules);
              const effectiveOpts = excludedFields
                ? new Set([...updateOpts].filter((o) => !excludedFields.includes(o)))
                : updateOpts;
              await processProduct({
                shopDomain,
                admin,
                sku,
                row,
                lineNumber,
                config,
                columnMaps,
                locationId,
                updateOpts: effectiveOpts,
                result,
                processedInventoryItems,
              });
              retried = true;
              break;
            } catch (retryErr: any) {
              if (attempt === config.maxRetries) {
                result.errors.push({ sku, error: retryErr?.message || errorMsg, lineNumber });
              }
            }
          }

          if (!retried && !result.errors.find((e) => e.sku === sku)) {
            result.errors.push({ sku, error: errorMsg, lineNumber });
          }
        }
        await new Promise((r) => setTimeout(r, 500));

        // Update progress every 10 products
        if (checkCounter % 10 === 0) {
          const processed = result.created + result.updated + result.unchanged + result.excluded;
          await prisma.importLog.update({
            where: { id: log.id },
            data: {
              totalProducts: result.totalProducts,
              created: result.created,
              updated: result.updated,
              unchanged: result.unchanged,
              excludedCount: excludedCount + result.excluded,
              lastSku: result.lastSku || null,
              lastProgressAt: new Date(),
            },
          }).catch(() => {});
        }
      }
      if (cancelled) break;
    }

    if (!cancelled && !hasAnyFilter) {
    const existingMappings = await prisma.productMapping.findMany({
      where: { shopDomain, configId: config.id },
    });

    for (const mapping of existingMappings) {
      if (!csvSkus.includes(mapping.supplierSku)) {
        try {
          await graphqlWithRetry(admin,
            `#graphql
            mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
              inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
                inventoryAdjustmentGroup { id }
                userErrors { field message code }
              }
            }`,
            {
              input: {
                reason: "correction",
                name: "available",
                changes: [{
                  inventoryItemId: mapping.shopifyInventoryItemId || mapping.shopifyProductId,
                  locationId,
                  delta: -(mapping.lastQuantity || 0),
                  changeFromQuantity: mapping.lastQuantity || 0,
                }],
              },
              idempotencyKey: `inv-absent-${mapping.shopifyInventoryItemId || mapping.shopifyProductId}-${locationId}-${Date.now()}`,
            }
          );
        } catch {
          // Si falla el ajuste de stock, no detener la importación
        }
      }
    }
    } // end if (!cancelled)

    await prisma.importLog.update({
      where: { id: log.id },
      data: {
        status: result.errors.length > 0 ? "completed_with_errors" : "completed",
        totalProducts: result.totalProducts,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        priceChanges: result.priceChanges,
        stockChanges: result.stockChanges,
        excludedCount: excludedCount + result.excluded,
        errors: result.errors.length > 0 ? JSON.stringify(result.errors) : null,
        lastSku: result.lastSku || null,
        completedAt: new Date(),
      },
    });

    await prisma.importConfig.update({
      where: { id: config.id },
      data: { lastImportAt: new Date() },
    });
  } catch (error: any) {
    await prisma.importLog.update({
      where: { id: log.id },
      data: {
        status: "failed",
        totalProducts: result.totalProducts,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        excludedCount: excludedCount + result.excluded,
        errors: JSON.stringify([{ error: error?.message || "Error general" }]),
        lastSku: result.lastSku || null,
        completedAt: new Date(),
      },
    });
    throw error;
  }

  cleanupOldLogs(config.id).catch(() => {});

  return result;
}

interface ProcessProductOptions {
  shopDomain: string;
  admin: any;
  sku: string;
  row: any;
  lineNumber: number;
  config: any;
  columnMaps: Array<{ shopifyField: string; csvColumn: string | null; defaultValue: string | null }>;
  locationId: string;
  updateOpts: Set<string>;
  result: ImportResult;
  processedInventoryItems: Set<string>;
}

async function processProduct({
  shopDomain,
  admin,
  sku,
  row,
  config,
  columnMaps,
  locationId,
  updateOpts,
  result,
  processedInventoryItems,
}: ProcessProductOptions): Promise<void> {
  let existing = await prisma.productMapping.findUnique({
    where: { shopDomain_supplierSku: { shopDomain, supplierSku: sku } },
  });

  const costPrice = parseFloat((getField(row, columnMaps, "price") || "0").replace(",", "."));
  const category = getField(row, columnMaps, "category");
  const newQty = parseInt((getField(row, columnMaps, "quantity") || row["quantity"] || "0").replace(",", "."));
  console.log(`[Import] processProduct SKU=${sku}, existing=${!!existing}, qty=${newQty}, skipZero=${config.skipZeroStockCreate}, columnMaps=${JSON.stringify(columnMaps.map(m => m.shopifyField + "->" + m.csvColumn))}`);

  // === INTER-SUPPLIER CHECK: existing mapping may belong to another supplier ===
  const shopSettings0 = await prisma.shopSettings.findUnique({ where: { shopDomain } });
  const dupPolicy0 = shopSettings0?.duplicatePolicy || "create_both";
  if (existing && existing.configId !== config.id && (dupPolicy0 === "skip_existing" || dupPolicy0 === "priority")) {
    const otherConfig = await prisma.importConfig.findUnique({ where: { id: existing.configId } });
    const otherSupplierName = otherConfig?.name || "desconocido";
    if (dupPolicy0 === "priority") {
      console.log(`[Import] SKU ${sku}: existing mapping belongs to "${otherSupplierName}" (configId=${existing.configId}), current configId=${config.id}, reemplazando por priority`);
      // Execute full replace (same logic as priorityReplaceTarget below)
      const prices2 = await calculatePrices(shopDomain, sku, category, costPrice, config.id);
      const categoryMap2 = config.categoryMaps?.filter(
        (cm: any) => cm.csvCategory === category && cm.isActive
      ) || [];
      const collectionIds2 = categoryMap2.map((cm: any) => cm.collectionId);
      const categoryTags2 = categoryMap2.map((cm: any) => cm.tags).filter(Boolean).join(",");
      const shopifyProductType2 = categoryMap2.find((cm: any) => cm.shopifyProductType)?.shopifyProductType || null;
      const productInput2 = mapCsvRowToProductSet(
        row, columnMaps, prices2, collectionIds2, locationId,
        config.defaultTags || undefined,
        categoryTags2 || undefined
      );
      if (shopifyProductType2) productInput2.productType = shopifyProductType2;

      // Full overwrite: update ALL fields on the existing product
      const fullPatch: any = {
        id: existing.shopifyProductId,
        title: productInput2.title,
        descriptionHtml: productInput2.descriptionHtml,
        productType: productInput2.productType,
        vendor: productInput2.vendor,
        tags: productInput2.tags,
        metafields: productInput2.metafields,
        seo: productInput2.seo,
      };
      const updateRes = await graphqlWithRetry(admin,
        `#graphql
        mutation productUpdate($product: ProductUpdateInput!) {
          productUpdate(product: $product) { product { id } userErrors { field message } }
        }`,
        { product: fullPatch }
      );
      if (updateRes.data?.productUpdate?.userErrors?.length) {
        const updateErrors = updateRes.data.productUpdate.userErrors;
        const notFound = updateErrors.some((e: any) =>
          e.message?.includes("not find") || e.message?.includes("NOT_FOUND") || e.message?.includes("was not found")
        );
        if (notFound) {
          console.log(`[Import] Priority replace: product ${existing.shopifyProductId} not found, skipping replace`);
          return;
        }
        console.error(`[Import] Priority replace: productUpdate errors:`, JSON.stringify(updateErrors));
      }

      // Update variant: SKU + price + compareAt + barcode
      const variantRes2 = await graphqlWithRetry(admin,
        `#graphql
        query { product(id: "${existing.shopifyProductId}") {
          variants(first: 1) { edges { node { id inventoryItem { id } } } }
        }}`,
        {}
      );
      const variantId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.id;
      const invItemId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.inventoryItem?.id;
      const rowEanForReplace = getField(row, columnMaps, "ean") || row["ean"] || "";
      if (variantId2) {
        const variantPatch: any = {
          id: variantId2,
          price: prices2.regularPrice.toString(),
          compareAtPrice: (prices2.compareAtPrice ?? 0) > 0 ? prices2.compareAtPrice!.toString() : null,
        };
        if (rowEanForReplace) variantPatch.barcode = rowEanForReplace;
        await graphqlWithRetry(admin,
          `#graphql
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants { id } userErrors { field message }
            }
          }`,
          {
            productId: existing.shopifyProductId,
            variants: [variantPatch],
          }
        );
        if (sku && variantId2) {
          try {
            await updateVariantSku(admin, existing.shopifyProductId, variantId2, sku);
          } catch (e: any) {
            console.error("[Import] Priority replace: error updating SKU:", e?.message);
          }
        }
      }

      // Update stock
      if (invItemId2 && locationId) {
        try {
          await setInventoryQuantity(admin, invItemId2, locationId, newQty);
        } catch (error: any) {
          console.error("[Import] Priority replace: error updating stock:", error);
        }
      }

      // Update cost
      if (costPrice > 0 && invItemId2) {
        try {
          await updateInventoryItem(admin, invItemId2, { cost: costPrice.toString() });
        } catch (error: any) {
          console.error("[Import] Priority replace: error updating cost:", error);
        }
      }

      // Update weight
      const weightValue = parseFloat((getField(row, columnMaps, "weight") || "0").replace(",", "."));
      if (weightValue > 0 && invItemId2) {
        try {
          await updateInventoryItem(admin, invItemId2, { measurement: { weight: { value: weightValue, unit: "KILOGRAMS" } } });
        } catch (error: any) {
          console.error("[Import] Priority replace: error updating weight:", error);
        }
      }

      // Update images
      if (productInput2.files.length > 0) {
        try {
          await graphqlWithRetry(admin,
            `#graphql
            mutation productCreateMedia($id: ID!, $media: [CreateMediaInput!]!) {
              productCreateMedia(productId: $id, media: $media) { media { id } userErrors { field message } }
            }`,
            { id: existing.shopifyProductId, media: productInput2.files.map((f) => ({ originalSource: f.originalSource, alt: f.alt, mediaContentType: f.contentType })) }
          );
        } catch (error: any) {
          console.error("[Import] Priority replace: error updating images:", error);
        }
      }

      // Delete old mapping, create new one for current supplier
      await prisma.productMapping.delete({ where: { id: existing.id } });
      const newMapping2 = await prisma.productMapping.create({
        data: {
          shopDomain,
          configId: config.id,
          supplierSku: sku,
          ean: rowEanForReplace || null,
          shopifyProductId: existing.shopifyProductId,
          shopifyVariantId: variantId2 || null,
          shopifyInventoryItemId: invItemId2 || null,
          lastPrice: prices2.regularPrice,
          lastComparePrice: prices2.compareAtPrice,
          lastQuantity: newQty,
          lastCost: costPrice > 0 ? costPrice : null,
        },
      });
      existing = newMapping2;
      result.updated++;
      return;
    } else {
      // skip_existing: skip (different supplier already owns this product)
      console.log(`[Import] SKU ${sku}: existing mapping belongs to "${otherSupplierName}", saltando por skip_existing`);
      result.excluded++;
      return;
    }
  }

  // === DUPLICATE CHECK: skip_existing and priority (EAN-based via checkDuplicate) ===
  {
    const rowEan = getField(row, columnMaps, "ean") || row["ean"] || "";
    console.log(`[Import] SKU ${sku}: rowEan="${rowEan}", eanField=${getField(row, columnMaps, "ean")}, rawEan=${row["ean"]}`);
    const shopSettings = await prisma.shopSettings.findUnique({ where: { shopDomain } });
    const dupPolicy = shopSettings?.duplicatePolicy || "create_both";
    if (rowEan && (dupPolicy === "skip_existing" || dupPolicy === "priority")) {
      const dupCheck = await checkDuplicate(shopDomain, config.id, rowEan);
      if (dupCheck.shouldSkip) {
        console.log(`[Import] SKU ${sku}: EAN ${rowEan} duplicado de proveedor "${dupCheck.existingSupplierName}", saltando por ${dupPolicy}`);
        result.excluded++;
        return;
      }
      if (dupCheck.shouldReplace && dupCheck.existingMappingId && dupCheck.existingShopifyProductId) {
        console.log(`[Import] SKU ${sku}: prioridad sobre "${dupCheck.existingSupplierName}", reemplazando producto ${dupCheck.existingShopifyProductId}`);
        const prices2 = await calculatePrices(shopDomain, sku, category, costPrice, config.id);
        const categoryMap2 = config.categoryMaps?.filter(
          (cm: any) => cm.csvCategory === category && cm.isActive
        ) || [];
        const collectionIds2 = categoryMap2.map((cm: any) => cm.collectionId);
        const categoryTags2 = categoryMap2.map((cm: any) => cm.tags).filter(Boolean).join(",");
        const shopifyProductType2 = categoryMap2.find((cm: any) => cm.shopifyProductType)?.shopifyProductType || null;
        const productInput2 = mapCsvRowToProductSet(
          row, columnMaps, prices2, collectionIds2, locationId,
          config.defaultTags || undefined,
          categoryTags2 || undefined
        );
        if (shopifyProductType2) productInput2.productType = shopifyProductType2;

        // Full overwrite: update ALL fields on the existing product
        const fullPatch: any = {
          id: dupCheck.existingShopifyProductId,
          title: productInput2.title,
          descriptionHtml: productInput2.descriptionHtml,
          productType: productInput2.productType,
          vendor: productInput2.vendor,
          tags: productInput2.tags,
          metafields: productInput2.metafields,
          seo: productInput2.seo,
        };
        const updateRes = await graphqlWithRetry(admin,
          `#graphql
          mutation productUpdate($product: ProductUpdateInput!) {
            productUpdate(product: $product) { product { id } userErrors { field message } }
          }`,
          { product: fullPatch }
        );
        const updateErrors = updateRes.data?.productUpdate?.userErrors || [];
        if (updateErrors.length) {
          const notFound = updateErrors.some((e: any) =>
            e.message?.includes("not find") || e.message?.includes("NOT_FOUND") || e.message?.includes("was not found")
          );
          if (notFound) {
            console.log(`[Import] Priority replace: product ${dupCheck.existingShopifyProductId} not found, skipping replace`);
            return;
          }
          console.error(`[Import] Priority replace: productUpdate errors:`, JSON.stringify(updateErrors));
        } else {
          console.log(`[Import] Priority replace: productUpdate OK for ${dupCheck.existingShopifyProductId}`);
        }

        // Update variant: SKU + price + compareAt + barcode
        const variantRes2 = await graphqlWithRetry(admin,
          `#graphql
          query { product(id: "${dupCheck.existingShopifyProductId}") {
            variants(first: 1) { edges { node { id inventoryItem { id } } } }
          }}`,
          {}
        );
        const variantId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.id;
        const invItemId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.inventoryItem?.id;
        console.log(`[Import] Priority replace: variant query result: variantId=${variantId2}, invItemId=${invItemId2}`);
        if (variantId2) {
          try {
            const variantPatch: any = {
              id: variantId2,
              price: prices2.regularPrice.toString(),
              compareAtPrice: (prices2.compareAtPrice ?? 0) > 0 ? prices2.compareAtPrice!.toString() : null,
            };
            if (rowEan) variantPatch.barcode = rowEan;
            console.log(`[Import] Priority replace: updating variant ${variantId2}, price=${prices2.regularPrice}, compareAt=${prices2.compareAtPrice}, barcode=${rowEan}`);
            const variantUpdateRes = await graphqlWithRetry(admin,
              `#graphql
              mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                  productVariants { id } userErrors { field message }
                }
              }`,
              {
                productId: dupCheck.existingShopifyProductId,
                variants: [variantPatch],
              }
            );
            if (variantUpdateRes.data?.productVariantsBulkUpdate?.userErrors?.length) {
              console.error(`[Import] Priority replace: variantUpdate errors:`, JSON.stringify(variantUpdateRes.data.productVariantsBulkUpdate.userErrors));
            } else {
              console.log(`[Import] Priority replace: variant update OK`);
            }
            if (sku) {
              try {
                await updateVariantSku(admin, dupCheck.existingShopifyProductId, variantId2, sku);
                console.log(`[Import] Priority replace: SKU updated to ${sku}`);
              } catch (e: any) {
                console.error(`[Import] Priority replace: error updating SKU:`, e?.message);
              }
            }
          } catch (e: any) {
            console.error(`[Import] Priority replace: variant update EXCEPTION:`, e?.message || String(e));
          }
        } else {
          console.error(`[Import] Priority replace: no variantId found for product ${dupCheck.existingShopifyProductId}`);
        }

        console.log(`[Import] Priority replace: proceeding to stock/cost/weight, invItemId=${invItemId2}, locationId=${locationId ? locationId.substring(0, 20) + "..." : "NULL"}`);

        // Update stock at configured location
        if (invItemId2 && locationId) {
          try {
            await setInventoryQuantity(admin, invItemId2, locationId, newQty);
          } catch (error: any) {
            console.error("[Import] Priority replace: error updating stock:", error);
          }
        }

        // Update cost
        if (costPrice > 0 && invItemId2) {
          try {
            console.log(`[Import] Priority replace: updating cost to ${costPrice} on inventory item ${invItemId2}`);
            await updateInventoryItem(admin, invItemId2, { cost: costPrice.toString() });
          } catch (error: any) {
            console.error("[Import] Priority replace: error updating cost:", error);
          }
        }

        // Update weight
        const weightValue = parseFloat((getField(row, columnMaps, "weight") || "0").replace(",", "."));
        if (weightValue > 0 && invItemId2) {
          try {
            await updateInventoryItem(admin, invItemId2, { measurement: { weight: { value: weightValue, unit: "KILOGRAMS" } } });
          } catch (error: any) {
            console.error("[Import] Priority replace: error updating weight:", error);
          }
        }

        // Update images
        if (productInput2.files.length > 0) {
          try {
            await graphqlWithRetry(admin,
              `#graphql
              mutation productCreateMedia($id: ID!, $media: [CreateMediaInput!]!) {
                productCreateMedia(productId: $id, media: $media) { media { id } userErrors { field message } }
              }`,
              { id: dupCheck.existingShopifyProductId, media: productInput2.files.map((f) => ({ originalSource: f.originalSource, alt: f.alt, mediaContentType: f.contentType })) }
            );
          } catch (error: any) {
            console.error("[Import] Priority replace: error updating images:", error);
          }
        }

        // Update mapping: delete old (other supplier) + any existing for this SKU, then create new
        try {
          console.log(`[Import] Priority replace: deleting old mapping ${dupCheck.existingMappingId}`);
          await prisma.productMapping.delete({ where: { id: dupCheck.existingMappingId } });
          console.log(`[Import] Priority replace: old mapping deleted`);
        } catch (e: any) {
          console.error(`[Import] Priority replace: error deleting old mapping:`, e?.message);
        }
        // Delete any existing mapping for this SKU from current supplier (unique constraint)
        if (existing && existing.configId === config.id) {
          try {
            console.log(`[Import] Priority replace: deleting existing mapping for same SKU ${existing.id}`);
            await prisma.productMapping.delete({ where: { id: existing.id } });
          } catch (e: any) {
            console.error(`[Import] Priority replace: error deleting existing mapping:`, e?.message);
          }
        }
        try {
          console.log(`[Import] Priority replace: creating new mapping sku=${sku}, ean=${rowEan || null}, productId=${dupCheck.existingShopifyProductId}, configId=${config.id}`);
          const newMapping2 = await prisma.productMapping.create({
            data: {
              shopDomain,
              configId: config.id,
              supplierSku: sku,
              ean: rowEan || null,
              shopifyProductId: dupCheck.existingShopifyProductId,
              shopifyVariantId: variantId2 || null,
              shopifyInventoryItemId: invItemId2 || null,
              lastPrice: prices2.regularPrice,
              lastComparePrice: prices2.compareAtPrice,
              lastQuantity: newQty,
              lastCost: costPrice > 0 ? costPrice : null,
            },
          });
          console.log(`[Import] Priority replace: new mapping created ${newMapping2.id}`);
          existing = newMapping2;
        } catch (e: any) {
          console.error(`[Import] Priority replace: error creating new mapping:`, e?.message);
        }
        result.updated++;
        return;
      }
    }
  }

  const prices = await calculatePrices(shopDomain, sku, category, costPrice, config.id);

  const categoryMap = config.categoryMaps?.filter(
    (cm: any) => cm.csvCategory === category && cm.isActive
  ) || [];
  const collectionIds = categoryMap.map((cm: any) => cm.collectionId);
  const categoryTags = categoryMap.map((cm: any) => cm.tags).filter(Boolean).join(",");
  const shopifyProductType = categoryMap.find((cm: any) => cm.shopifyProductType)?.shopifyProductType || null;

  const productInput = mapCsvRowToProductSet(
    row, columnMaps, prices, collectionIds, locationId,
    config.defaultTags || undefined,
    categoryTags || undefined
  );

  if (shopifyProductType) productInput.productType = shopifyProductType;

  // Verify mapping is still valid in Shopify
  if (existing) {
    try {
      const checkJson = await graphqlWithRetry(admin,
        `#graphql
        query productById($id: ID!) {
          product(id: $id) { id title }
        }`,
        { id: existing.shopifyProductId }
      );
      if (checkJson.data?.product?.id) {
        // Product exists — keep mapping
      } else if (checkJson.errors?.length) {
        console.log(`[Import] SKU ${sku}: GraphQL error verificando producto (${existing.shopifyProductId}): ${JSON.stringify(checkJson.errors)}`);
        // Don't delete mapping on GraphQL errors
        return;
      } else {
        // Product not found by ID — try SKU search before deleting
        console.log(`[Import] SKU ${sku}: producto ${existing.shopifyProductId} no encontrado por ID, verificando por SKU...`);
        const skuCheck = await graphqlWithRetry(admin,
          `#graphql
          query { productVariants(first: 1, query: "sku:${sku}") {
            edges { node { id product { id } inventoryItem { id } } }
          }}`,
          {}
        );
        const found = skuCheck.data?.productVariants?.edges?.[0]?.node;
        if (found?.product?.id) {
          // Product exists with different ID — update mapping
          console.log(`[Import] SKU ${sku}: producto encontrado por SKU (${found.product.id}), actualizando mapping`);
          await prisma.productMapping.update({
            where: { id: existing.id },
            data: {
              shopifyProductId: found.product.id,
              shopifyVariantId: found.id,
              shopifyInventoryItemId: found.inventoryItem?.id ?? existing.shopifyInventoryItemId,
            },
          });
          existing = await prisma.productMapping.findUnique({ where: { id: existing.id } });
        } else {
          console.log(`[Import] SKU ${sku}: producto eliminado de Shopify, recreando`);
          await prisma.productMapping.delete({ where: { id: existing.id } });
          existing = null;
        }
      }
    } catch (error: any) {
      console.log(`[Import] SKU ${sku}: error de red verificando producto, saltando: ${error?.message}`);
      return;
    }
  }

  // If no existing mapping, try to find product in Shopify by SKU+barcode
  let priorityReplaceTarget: { mappingId: string; shopifyProductId: string; supplierName: string; configId: string } | null = null;
  if (!existing) {
    if (config.skipZeroStockCreate && newQty <= 0) {
      result.excluded++;
      return;
    }

    const rowSku = getField(row, columnMaps, "sku") || row["sku"] || row["SKU"] || "";
    const rowEan = getField(row, columnMaps, "ean") || row["ean"] || "";
    const dupPolicy2 = (await prisma.shopSettings.findUnique({ where: { shopDomain } }))?.duplicatePolicy || "create_both";

    try {
      let foundProductId: string | null = null;
      let foundVariantId: string | null = null;
      let foundInventoryItemId: string | null = null;

      if (rowSku && rowEan) {
        const combinedRes = await graphqlWithRetry(admin,
          `#graphql
          query { productVariants(first: 1, query: "sku:${rowSku} AND barcode:${rowEan}") {
            edges { node { id sku product { id } inventoryItem { id } } }
          }}`,
          {}
        );
        const v = combinedRes.data?.productVariants?.edges?.[0]?.node;
        if (v?.product?.id) {
          const foundSku = (v.sku || "").trim();
          if (foundSku && foundSku !== sku) {
            // SKU mismatch — check if it's intra or inter
            const foundMapping = await prisma.productMapping.findFirst({
              where: { shopDomain, shopifyProductId: v.product.id },
            });
            if (foundMapping && foundMapping.configId !== config.id) {
              // Inter-supplier: different supplier owns this product
              if (dupPolicy2 === "priority") {
                // Inter + priority: full replace (overwrite everything)
                const suppName2 = (await prisma.importConfig.findUnique({ where: { id: foundMapping.configId } }))?.name || "desconocido";
                console.log(`[Import] SKU ${sku}: inter-supplier combined match, SKU "${foundSku}" != "${sku}", reemplazando por priority (proveedor "${suppName2}")`);
                priorityReplaceTarget = { mappingId: foundMapping.id, shopifyProductId: foundMapping.shopifyProductId, supplierName: suppName2, configId: foundMapping.configId };
                // Don't set foundProductId — we'll handle replace separately
              } else if (dupPolicy2 === "create_both") {
                console.log(`[Import] SKU ${sku}: inter-supplier combined match, SKU "${foundSku}" != "${sku}", create_both: creando nuevo producto`);
              } else {
                // Inter + skip_existing: skip
                console.log(`[Import] SKU ${sku}: inter-supplier combined match, SKU "${foundSku}" != "${sku}", saltando por ${dupPolicy2}`);
                result.excluded++;
                return;
              }
            } else if (dupPolicy2 === "create_both") {
              // Intra or external + create_both: create new
              console.log(`[Import] SKU ${sku}: create_both, SKU "${foundSku}" != "${sku}", creando nuevo`);
            } else {
              // Intra or external + skip_existing/priority: skip
              console.log(`[Import] SKU ${sku}: producto encontrado con SKU "${foundSku}" (diferente), saltando por ${dupPolicy2}`);
              result.excluded++;
              return;
            }
          } else {
            foundProductId = v.product.id; foundVariantId = v.id; foundInventoryItemId = v.inventoryItem?.id ?? null;
          }
        }
      }
      if (!foundProductId && rowSku) {
        const skuRes = await graphqlWithRetry(admin,
          `#graphql
          query { productVariants(first: 1, query: "sku:${rowSku}") {
            edges { node { id sku product { id } inventoryItem { id } } }
          }}`,
          {}
        );
        const v = skuRes.data?.productVariants?.edges?.[0]?.node;
        if (v?.product?.id) {
          const foundSku = (v.sku || "").trim();
          if (foundSku && foundSku !== sku) {
            const foundMapping = await prisma.productMapping.findFirst({
              where: { shopDomain, shopifyProductId: v.product.id },
            });
            if (foundMapping && foundMapping.configId !== config.id) {
              if (dupPolicy2 === "priority") {
                const suppName2 = (await prisma.importConfig.findUnique({ where: { id: foundMapping.configId } }))?.name || "desconocido";
                console.log(`[Import] SKU ${sku}: inter-supplier SKU match, SKU "${foundSku}" != "${sku}", reemplazando por priority (proveedor "${suppName2}")`);
                priorityReplaceTarget = { mappingId: foundMapping.id, shopifyProductId: foundMapping.shopifyProductId, supplierName: suppName2, configId: foundMapping.configId };
              } else if (dupPolicy2 === "create_both") {
                console.log(`[Import] SKU ${sku}: inter-supplier SKU match, SKU "${foundSku}" != "${sku}", create_both: creando nuevo producto`);
              } else {
                console.log(`[Import] SKU ${sku}: inter-supplier SKU match, SKU "${foundSku}" != "${sku}", saltando por ${dupPolicy2}`);
                result.excluded++;
                return;
              }
            } else if (dupPolicy2 === "create_both") {
              console.log(`[Import] SKU ${sku}: create_both, SKU "${foundSku}" != "${sku}", creando nuevo`);
            } else {
              console.log(`[Import] SKU ${sku}: producto encontrado con SKU "${foundSku}" (diferente), saltando por ${dupPolicy2}`);
              result.excluded++;
              return;
            }
          } else {
            foundProductId = v.product.id; foundVariantId = v.id; foundInventoryItemId = v.inventoryItem?.id ?? null;
          }
        }
      }

      if (!foundProductId && rowEan) {
        const barcodeRes = await graphqlWithRetry(admin,
          `#graphql
          query { productVariants(first: 1, query: "barcode:${rowEan}") {
            edges { node { id sku product { id } inventoryItem { id } } }
          }}`,
          {}
        );
        const v = barcodeRes.data?.productVariants?.edges?.[0]?.node;
        if (v?.product?.id) {
          const foundSku = (v.sku || "").trim();
          console.log(`[Import] SKU ${sku}: barcode ${rowEan} found in Shopify (productId=${v.product.id}, foundSku="${foundSku}")`);
          if (foundSku && foundSku !== sku) {
            const foundMapping = await prisma.productMapping.findFirst({
              where: { shopDomain, shopifyProductId: v.product.id },
            });
            if (foundMapping && foundMapping.configId !== config.id) {
              if (dupPolicy2 === "priority") {
                const suppName2 = (await prisma.importConfig.findUnique({ where: { id: foundMapping.configId } }))?.name || "desconocido";
                console.log(`[Import] SKU ${sku}: inter-supplier barcode match, SKU "${foundSku}" != "${sku}", reemplazando por priority (proveedor "${suppName2}")`);
                priorityReplaceTarget = { mappingId: foundMapping.id, shopifyProductId: foundMapping.shopifyProductId, supplierName: suppName2, configId: foundMapping.configId };
              } else if (dupPolicy2 === "create_both") {
                console.log(`[Import] SKU ${sku}: inter-supplier barcode match, SKU "${foundSku}" != "${sku}", create_both: creando nuevo producto`);
              } else {
                console.log(`[Import] SKU ${sku}: inter-supplier barcode match, SKU "${foundSku}" != "${sku}", saltando por ${dupPolicy2}`);
                result.excluded++;
                return;
              }
            } else if (dupPolicy2 === "create_both") {
              console.log(`[Import] SKU ${sku}: create_both, barcode match pero SKU "${foundSku}" != "${sku}", creando nuevo`);
            } else {
              console.log(`[Import] SKU ${sku}: producto encontrado con SKU "${foundSku}" (diferente), saltando por ${dupPolicy2}`);
              result.excluded++;
              return;
            }
          } else {
            foundProductId = v.product.id; foundVariantId = v.id; foundInventoryItemId = v.inventoryItem?.id ?? null;
          }
        }
      }

      if (foundProductId) {
        if (!foundInventoryItemId && foundVariantId) {
          try {
            const invRes = await graphqlWithRetry(admin,
              `#graphql
              query { productVariant(id: "${foundVariantId}") { inventoryItem { id } } }`,
              {}
            );
            foundInventoryItemId = invRes.data?.productVariant?.inventoryItem?.id ?? null;
          } catch {}
        }

        // Check if the found product has a different SKU → skip for skip_existing
        const foundSkuRes = await graphqlWithRetry(admin,
          `#graphql
          query { productVariants(first: 1, query: "product_id:${foundProductId}") {
            edges { node { id sku } }
          }}`,
          {}
        );
        const foundSku = (foundSkuRes.data?.productVariants?.edges?.[0]?.node?.sku || "").trim();
        if (dupPolicy2 === "skip_existing" && foundSku && foundSku !== sku) {
          console.log(`[Import] SKU ${sku}: producto encontrado por barcode con SKU "${foundSku}" (diferente), saltando por skip_existing`);
          result.excluded++;
          return;
        }

        console.log(`[Import] SKU ${rowSku}: producto existente encontrado (${foundProductId}), variantId=${foundVariantId}, inventoryItemId=${foundInventoryItemId}`);
        const mapping = await prisma.productMapping.upsert({
          where: { shopDomain_supplierSku: { shopDomain, supplierSku: sku } },
          create: {
            shopDomain, configId: config.id, supplierSku: sku, ean: rowEan || null,
            shopifyProductId: foundProductId, shopifyVariantId: foundVariantId, shopifyInventoryItemId: foundInventoryItemId,
          lastPrice: prices.regularPrice,
          lastComparePrice: prices.compareAtPrice,
          lastQuantity: newQty,
          lastCost: costPrice > 0 ? costPrice : null,
          },
          update: {
            shopifyProductId: foundProductId, shopifyVariantId: foundVariantId, shopifyInventoryItemId: foundInventoryItemId,
          },
        });
        existing = mapping;
      }
    } catch (error: any) {
      console.log(`[Import] SKU ${rowSku}: error buscando producto existente: ${error?.message}`);
    }
  }

  // === PRIORITY REPLACE: full overwrite for inter-supplier priority ===
  if (priorityReplaceTarget) {
    console.log(`[Import] SKU ${sku}: executing full priority replace on product ${priorityReplaceTarget.shopifyProductId} (was from "${priorityReplaceTarget.supplierName}")`);
    const prices2 = await calculatePrices(shopDomain, sku, category, costPrice, config.id);
    const categoryMap2 = config.categoryMaps?.filter(
      (cm: any) => cm.csvCategory === category && cm.isActive
    ) || [];
    const collectionIds2 = categoryMap2.map((cm: any) => cm.collectionId);
    const categoryTags2 = categoryMap2.map((cm: any) => cm.tags).filter(Boolean).join(",");
    const shopifyProductType2 = categoryMap2.find((cm: any) => cm.shopifyProductType)?.shopifyProductType || null;
    const productInput2 = mapCsvRowToProductSet(
      row, columnMaps, prices2, collectionIds2, locationId,
      config.defaultTags || undefined,
      categoryTags2 || undefined
    );
    if (shopifyProductType2) productInput2.productType = shopifyProductType2;

    // Full overwrite: update ALL fields on the existing product
    const fullPatch: any = {
      id: priorityReplaceTarget.shopifyProductId,
      title: productInput2.title,
      descriptionHtml: productInput2.descriptionHtml,
      productType: productInput2.productType,
      vendor: productInput2.vendor,
      tags: productInput2.tags,
      metafields: productInput2.metafields,
      seo: productInput2.seo,
    };
    const updateRes = await graphqlWithRetry(admin,
      `#graphql
      mutation productUpdate($product: ProductUpdateInput!) {
        productUpdate(product: $product) { product { id } userErrors { field message } }
      }`,
      { product: fullPatch }
    );
    if (updateRes.data?.productUpdate?.userErrors?.length) {
      const updateErrors = updateRes.data.productUpdate.userErrors;
      const notFound = updateErrors.some((e: any) =>
        e.message?.includes("not find") || e.message?.includes("NOT_FOUND") || e.message?.includes("was not found")
      );
      if (notFound) {
        console.log(`[Import] Priority replace: product ${priorityReplaceTarget.shopifyProductId} not found, skipping replace`);
        return;
      }
      console.error(`[Import] Priority replace: productUpdate errors:`, JSON.stringify(updateErrors));
    }

    // Update variant: SKU + price + compareAt + barcode
    const variantRes2 = await graphqlWithRetry(admin,
      `#graphql
      query { product(id: "${priorityReplaceTarget.shopifyProductId}") {
        variants(first: 1) { edges { node { id inventoryItem { id } } } }
      }}`,
      {}
    );
    const variantId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.id;
    const invItemId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.inventoryItem?.id;
    const rowEanForReplace = getField(row, columnMaps, "ean") || row["ean"] || "";
    if (variantId2) {
      const variantPatch: any = {
        id: variantId2,
        price: prices2.regularPrice.toString(),
        compareAtPrice: (prices2.compareAtPrice ?? 0) > 0 ? prices2.compareAtPrice!.toString() : null,
      };
      if (rowEanForReplace) variantPatch.barcode = rowEanForReplace;
      await graphqlWithRetry(admin,
        `#graphql
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id } userErrors { field message }
          }
        }`,
        {
          productId: priorityReplaceTarget.shopifyProductId,
          variants: [variantPatch],
        }
      );
      if (sku) {
        try {
          await updateVariantSku(admin, priorityReplaceTarget.shopifyProductId, variantId2, sku);
        } catch (e: any) {
          console.error("[Import] Priority replace: error updating SKU:", e?.message);
        }
      }
    }

    // Update stock at configured location
    if (invItemId2 && locationId) {
      try {
        await setInventoryQuantity(admin, invItemId2, locationId, newQty);
      } catch (error: any) {
        console.error("[Import] Priority replace: error updating stock:", error);
      }
    }

    // Update cost
    if (costPrice > 0 && invItemId2) {
      try {
        await updateInventoryItem(admin, invItemId2, { cost: costPrice.toString() });
      } catch (error: any) {
        console.error("[Import] Priority replace: error updating cost:", error);
      }
    }

    // Update weight
    const weightValue = parseFloat((getField(row, columnMaps, "weight") || "0").replace(",", "."));
    if (weightValue > 0 && invItemId2) {
      try {
        await updateInventoryItem(admin, invItemId2, { measurement: { weight: { value: weightValue, unit: "KILOGRAMS" } } });
      } catch (error: any) {
        console.error("[Import] Priority replace: error updating weight:", error);
      }
    }

    // Update images
    if (productInput2.files.length > 0) {
      try {
        await graphqlWithRetry(admin,
          `#graphql
          mutation productCreateMedia($id: ID!, $media: [CreateMediaInput!]!) {
            productCreateMedia(productId: $id, media: $media) { media { id } userErrors { field message } }
          }`,
          { id: priorityReplaceTarget.shopifyProductId, media: productInput2.files.map((f) => ({ originalSource: f.originalSource, alt: f.alt, mediaContentType: f.contentType })) }
        );
      } catch (error: any) {
        console.error("[Import] Priority replace: error updating images:", error);
      }
    }

    // Delete old mapping, create new one
    await prisma.productMapping.delete({ where: { id: priorityReplaceTarget.mappingId } });
    const newMapping2 = await prisma.productMapping.create({
      data: {
        shopDomain,
        configId: config.id,
        supplierSku: sku,
        ean: rowEanForReplace || null,
        shopifyProductId: priorityReplaceTarget.shopifyProductId,
        shopifyVariantId: variantId2 || null,
        shopifyInventoryItemId: invItemId2 || null,
        lastPrice: prices2.regularPrice,
        lastComparePrice: prices2.compareAtPrice,
        lastQuantity: newQty,
        lastCost: costPrice > 0 ? costPrice : null,
      },
    });
    existing = newMapping2;
    result.updated++;
    return;
  }

  // === SINGLE UPDATE PATH ===
  // Verify product still exists in Shopify (orphan detection)
  if (existing) {
    const exists = await verifyProductExists(admin, existing.shopifyProductId);
    if (!exists) {
      console.log(`[Import] SKU ${sku}: product ${existing.shopifyProductId} no longer exists, cleaning orphaned mapping and creating new`);
      await prisma.productMapping.delete({ where: { id: existing.id } });
      existing = null;
    }
  }
  if (existing) {
    // === CHANGE DETECTION: compare against last known values ===
    const lastPrice = existing.lastPrice ?? null;
    const lastQty = existing.lastQuantity ?? null;
    const lastCost = existing.lastCost ?? null;

    const priceChanged = updateOpts.has("price") && (lastPrice === null || lastPrice !== prices.regularPrice);
    const stockChanged = updateOpts.has("stock") && existing.shopifyInventoryItemId && (lastQty === null || lastQty !== newQty);
    const costChanged = costPrice > 0 && existing.shopifyInventoryItemId && Math.abs((lastCost ?? 0) - costPrice) > 0.001;

    const imagesChanged = updateOpts.has("images") && productInput.files.length > 0;

    // Only count as "unchanged" if price/stock/cost/images didn't change
    // Data fields are always sent (idempotent) but don't count toward "updated"
    if (!priceChanged && !stockChanged && !costChanged && !imagesChanged) {
      console.log(`[Import] SKU ${sku}: unchanged (lastPrice=${lastPrice}, csvPrice=${prices.regularPrice}, lastQty=${lastQty}, csvQty=${newQty})`);
      result.unchanged++;
      return;
    }

    console.log(`[Import] SKU ${sku}: updating (priceChanged=${priceChanged}, stockChanged=${stockChanged}, costChanged=${costChanged}, imagesChanged=${imagesChanged})`);

    const productPatch: any = { id: existing.shopifyProductId };
    if (updateOpts.has("name")) productPatch.title = productInput.title;
    if (updateOpts.has("description")) {
      productPatch.descriptionHtml = productInput.descriptionHtml;
      productPatch.seo = productInput.seo;
    }
    if (updateOpts.has("productType")) productPatch.productType = productInput.productType;
    if (updateOpts.has("vendor")) productPatch.vendor = productInput.vendor;
    if (updateOpts.has("tags")) productPatch.tags = productInput.tags;
    if (updateOpts.has("metafields")) {
      productPatch.metafields = productInput.metafields;
    } else {
      const costMeta = productInput.metafields?.filter((m) => m.key === "costo");
      if (costMeta?.length) productPatch.metafields = costMeta;
    }

    if (Object.keys(productPatch).length > 1) {
      const updateRes = await graphqlWithRetry(admin,
        `#graphql
        mutation productUpdate($product: ProductUpdateInput!) {
          productUpdate(product: $product) { product { id } userErrors { field message } }
        }`,
        { product: productPatch }
      );
      const updateErrors = updateRes.data?.productUpdate?.userErrors || [];
      const notFound = updateErrors.some((e: any) =>
        e.message?.includes("not find") || e.message?.includes("NOT_FOUND") || e.message?.includes("was not found")
      );
      if (notFound) {
        console.log(`[Import] SKU ${sku}: product ${existing.shopifyProductId} not found during update, cleaning orphan and creating new`);
        await prisma.productMapping.delete({ where: { id: existing.id } });
        result.created++;
        return;
      }
    }

    if (imagesChanged) {
      try {
        await graphqlWithRetry(admin,
          `#graphql
          mutation productCreateMedia($id: ID!, $media: [CreateMediaInput!]!) {
            productCreateMedia(productId: $id, media: $media) { media { id } userErrors { field message } }
          }`,
          { id: existing.shopifyProductId, media: productInput.files.map((f) => ({ originalSource: f.originalSource, alt: f.alt, mediaContentType: f.contentType })) }
        );
      } catch (error: any) {
        console.error("[Import] Error actualizando imágenes:", error);
      }
    }

    if (priceChanged) {
      const ean = getField(row, columnMaps, "ean");
      await graphqlWithRetry(admin,
        `#graphql
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id price }
            userErrors { field message }
          }
        }`,
        {
          productId: existing.shopifyProductId,
          variants: [{
            id: existing.shopifyVariantId || existing.shopifyProductId,
            price: String(isNaN(prices.regularPrice) ? 0 : prices.regularPrice),
            compareAtPrice: prices.compareAtPrice && !isNaN(prices.compareAtPrice) ? String(prices.compareAtPrice) : null,
            barcode: ean,
          }],
        }
      );
    }

    if (stockChanged && existing.shopifyInventoryItemId) {
      if (config.skipZeroStockCreate && newQty <= 0) {
        console.log(`[Import] Stock skip zero: SKU ${sku}, newQty=${newQty}`);
      } else if (processedInventoryItems.has(existing.shopifyInventoryItemId)) {
        console.log(`[Import] Stock skip duplicate: ${existing.shopifyInventoryItemId} (SKU ${sku})`);
      } else {
        processedInventoryItems.add(existing.shopifyInventoryItemId);
        try {
          await adjustStock(admin, existing.shopifyInventoryItemId, locationId, newQty, sku);
        } catch (error: any) {
          console.error("[Import] Error ajustando inventario:", error);
        }
      }
    } else if (stockChanged) {
      console.log(`[Import] Stock skip: no inventoryItemId (existing.shopifyInventoryItemId=${existing.shopifyInventoryItemId})`);
    }

    if (costChanged && existing.shopifyInventoryItemId) {
      const costo = getField(row, columnMaps, "price");
      const costValue = costo ? parseFloat(costo.replace(",", ".")) || 0 : 0;
      try {
        await graphqlWithRetry(admin,
          `#graphql
          mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
            inventoryItemUpdate(id: $id, input: $input) {
              inventoryItem { id unitCost { amount } }
              userErrors { field message }
            }
          }`,
          {
            id: existing.shopifyInventoryItemId,
            input: { cost: String(costValue) },
          }
        );
        await prisma.productMapping.update({
          where: { id: existing.id },
          data: { lastCost: costValue },
        });
      } catch (error: any) {
        console.error("[Import] Error seteando costo:", error?.message || error);
      }
    }

    if (updateOpts.has("collections") && productInput.collections?.length) {
      try {
        const currentCollections: string[] = [];
        let cursor: string | null = null;
        let colJson: any;
        do {
          colJson = await graphqlWithRetry(admin,
            `#graphql
            query productCollections($id: ID!, $first: Int!, $after: String) {
              product(id: $id) {
                collections(first: $first, after: $after) {
                  edges { node { id title } }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }`,
            { id: existing.shopifyProductId, first: 50, after: cursor }
          );
          const edges = colJson.data?.product?.collections?.edges || [];
          for (const e of edges) currentCollections.push(e.node.id);
          cursor = colJson.data?.product?.collections?.pageInfo?.hasNextPage
            ? colJson.data.product.collections.pageInfo.endCursor
            : null;
        } while (cursor);

        const desiredIds = productInput.collections.filter((c: any) => c.endsWith("Collection"));
        const toRemove = currentCollections.filter((id: string) => !desiredIds.includes(id));
        const toAdd = desiredIds.filter((id: string) => !currentCollections.includes(id));

        if (toRemove.length) {
          await graphqlWithRetry(admin,
            `#graphql
            mutation collectionRemove($id: ID!, $productIds: [ID!]!) {
              collectionRemoveProducts(id: $id, productIds: $productIds) {
                job { id }
                userErrors { field message }
              }
            }`,
            { id: toRemove[0], productIds: [existing.shopifyProductId] }
          );
        }
        for (const colId of toAdd) {
          await graphqlWithRetry(admin,
            `#graphql
            mutation collectionAdd($id: ID!, $productIds: [ID!]!) {
              collectionAddProducts(id: $id, productIds: $productIds) {
                job { id }
                userErrors { field message }
              }
            }`,
            { id: colId, productIds: [existing.shopifyProductId] }
          );
        }
      } catch (error: any) {
        console.error("[Import] Error actualizando colecciones:", error);
      }
    }

    try {
      await prisma.productMapping.update({
        where: { id: existing.id },
        data: {
          lastPrice: prices.regularPrice,
          lastComparePrice: prices.compareAtPrice,
          lastQuantity: newQty,
          lastCost: costPrice > 0 ? costPrice : undefined,
          lastSyncAt: new Date(),
        },
      });
    } catch {}

    result.updated++;
  } else {
    // === TRUE CREATE PATH (no existing product found anywhere) ===
    if (config.skipZeroStockCreate && newQty <= 0) {
      result.excluded++;
      return;
    }

    const rowSku = getField(row, columnMaps, "sku") || row["sku"] || row["SKU"] || "";
    const rowEan = getField(row, columnMaps, "ean") || row["ean"] || "";

    const productSetInput = {
      title: productInput.title,
      ...(productInput.descriptionHtml ? { descriptionHtml: productInput.descriptionHtml } : {}),
      ...(productInput.productType ? { productType: productInput.productType } : {}),
      ...(productInput.vendor ? { vendor: productInput.vendor } : {}),
      ...(productInput.tags?.length ? { tags: productInput.tags } : {}),
      ...(productInput.metafields?.length ? { metafields: productInput.metafields } : {}),
      seo: productInput.seo,
      status: config.productStatus,
      ...(productInput.files?.length ? { files: productInput.files } : {}),
      ...(productInput.collections?.length ? { collections: productInput.collections } : {}),
      productOptions: [
        {
          name: "Title",
          values: [{ name: "Default Title" }],
        },
      ],
      variants: [
        {
          optionValues: [{ optionName: "Title", name: "Default Title" }],
          price: String(isNaN(prices.regularPrice) ? 0 : prices.regularPrice),
          ...(prices.compareAtPrice && !isNaN(prices.compareAtPrice) ? { compareAtPrice: String(prices.compareAtPrice) } : {}),
          ...(rowEan ? { barcode: rowEan } : {}),
          ...(rowSku ? { sku: rowSku } : {}),
          inventoryPolicy: "DENY",
          inventoryItem: { tracked: true },
          inventoryQuantities: [
            {
              locationId,
              name: "available",
              quantity: parseInt((getField(row, columnMaps, "quantity") || row["quantity"] || "0").replace(",", ".")) || 0,
            },
          ],
        },
      ],
    };

    console.log(`[Import] SKU ${sku}: productSetInput.variant.price=${productSetInput.variants[0].price}, compareAt=${productSetInput.variants[0].compareAtPrice ?? "null"}, quantity=${productSetInput.variants[0].inventoryQuantities[0].quantity}, costPrice=${costPrice}, regularPrice=${prices.regularPrice}`);

    const json = await graphqlWithRetry(admin,
      `#graphql
      mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
        productSet(input: $input, synchronous: $synchronous) {
          product {
            id
            variants(first: 1) {
              edges {
                node {
                  id
                  inventoryItem { id }
                }
              }
            }
          }
          userErrors { field message code }
        }
      }`,
      {
        input: productSetInput,
        synchronous: true,
      }
    );

    const userErrors = json.data?.productSet?.userErrors || [];

    if (userErrors.length > 0) {
      console.log(`[Import] SKU ${sku}: productSet userErrors:`, JSON.stringify(userErrors));
      throw new Error(userErrors.map((e: any) => `${e.field?.join(".")}: ${e.message}`).join(", "));
    }

    const productId = json.data?.productSet?.product?.id;
    if (!productId) {
      throw new Error("No se devolvió el ID del producto creado");
    }

    const variant =
      json.data?.productSet?.product?.variants?.edges?.[0]?.node;

    let inventoryItemId = variant?.inventoryItem?.id ?? null;
    if (!inventoryItemId && variant?.id) {
      console.log(`[Import] SKU ${sku}: inventoryItem no devuelto por productSet, consultando...`);
      try {
        const variantRes = await graphqlWithRetry(admin,
          `#graphql
          query variantInventory($id: ID!) {
            productVariant(id: $id) { inventoryItem { id } }
          }`,
          { id: variant.id }
        );
        inventoryItemId = variantRes.data?.productVariant?.inventoryItem?.id ?? null;
        if (inventoryItemId) {
          console.log(`[Import] SKU ${sku}: inventoryItem recuperado = ${inventoryItemId}`);
        } else {
          console.log(`[Import] SKU ${sku}: inventoryItem NO encontrado, stock no se podrá actualizar`);
        }
      } catch (e: any) {
        console.log(`[Import] SKU ${sku}: error consultando inventoryItem: ${e?.message}`);
      }
    }

    const weight = parseFloat((getField(row, columnMaps, "weight") || row["weight"] || "0").replace(",", "."));
    const costo = getField(row, columnMaps, "price");

    if (variant?.id && inventoryItemId) {
      try {
        const input: any = {};
        if (weight > 0 && !isNaN(weight)) {
          input.measurement = { weight: { unit: "KILOGRAMS", value: weight } };
        }
        if (costo) {
          const parsedCost = parseFloat(costo.replace(",", "."));
          if (!isNaN(parsedCost) && parsedCost > 0) input.cost = String(parsedCost);
        }
        if (Object.keys(input).length > 0) {
          await graphqlWithRetry(admin,
            `#graphql
            mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
              inventoryItemUpdate(id: $id, input: $input) {
                inventoryItem { id unitCost { amount } }
                userErrors { field message }
              }
            }`,
            {
              id: variant.inventoryItem.id,
              input,
            }
          );
        }
      } catch (error: any) {
        console.error("[Import] Error seteando peso/costo:", error?.message || error);
      }
    }

    try {
      await prisma.productMapping.create({
        data: {
          shopDomain,
          configId: config.id,
          supplierSku: sku,
          ean: rowEan || null,
          shopifyProductId: productId,
          shopifyVariantId: variant?.id ?? null,
          shopifyInventoryItemId: inventoryItemId,
          lastPrice: prices.regularPrice,
          lastComparePrice: prices.compareAtPrice,
          lastQuantity: newQty,
          lastCost: costPrice > 0 ? costPrice : null,
        },
      });
    } catch {
      // Mapping may already exist from concurrent process
    }

    // Publish to selected sales channels (priority) or markets (only on CREATE)
    const allPublicationIds: string[] = [];
    if (config.publicationIds) {
      try { allPublicationIds.push(...JSON.parse(config.publicationIds)); } catch {}
    }
    if (allPublicationIds.length === 0 && config.marketIds) {
      try { allPublicationIds.push(...JSON.parse(config.marketIds)); } catch {}
    }
    if (allPublicationIds.length > 0) {
      try {
        const input = allPublicationIds.map((publicationId) => ({ publicationId }));
        const pubResult = await graphqlWithRetry(admin,
          `#graphql
          mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
            publishablePublish(id: $id, input: $input) {
              userErrors { field message }
            }
          }`,
          { id: productId, input }
        );
        const userErrors = pubResult.data?.publishablePublish?.userErrors || [];
        if (userErrors.length > 0) {
          console.error(`[Import] SKU ${sku}: publish errors:`, JSON.stringify(userErrors));
        } else {
          console.log(`[Import] SKU ${sku}: publicado en ${allPublicationIds.length} publicación(es): ${allPublicationIds.join(", ")}`);
        }
      } catch (error: any) {
        console.error(`[Import] SKU ${sku}: error publicando: ${error?.message}`);
      }
    } else {
      console.log(`[Import] SKU ${sku}: sin publications configuradas, saltando publicación`);
    }

    result.created++;
  }
}
