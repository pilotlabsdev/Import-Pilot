import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import { prisma, getOrCreateConfig, getEffectiveUrl, getSourceKey, cleanupOldLogs, ensureSingleSession } from "./db.server";
import { streamFile, isExcluded, parseExcludeFieldRules, getExcludedFields } from "./csv-parser.server";
import { getActivePriceRules, calculatePriceSync } from "./price-rules.server";
import { checkDuplicate, logDuplicate, logExternalDuplicate } from "./duplicate-detection.server";
import { rateLimitedGraphql } from "./import-locks.server";
import {
  mapCsvRowToBulkCreateInput,
  mapCsvRowToBulkUpdateInput,
  parseUpdateOptions,
  getField,
} from "./product-mapper.server";
import { getLocationId } from "./location.server";
import { ensureMetafieldDefinitions } from "./metafield-definitions";
import { sendNotification } from "./notifications.server";
import shopify from "~/shopify.server";

const MAX_CHUNK_BYTES = 80 * 1024 * 1024; // Shopify limita JSONL a 100MB

// Directorio de trabajo persistente (configurable vía env) para poder reanudar jobs tras un reinicio.
const BASE_WORK_DIR =
  process.env.BULK_DIR || path.join(os.tmpdir(), "shopify-import-bulk");

// Retención de jobs bulk terminados (done/failed) antes de limpiarlos de la BD y del disco.
const JOB_RETENTION_MS =
  (Number(process.env.MEDIMAX_JOB_RETENTION_DAYS) || 7) * 24 * 60 * 60 * 1000;

export function getBulkWorkDir(): string {
  return BASE_WORK_DIR;
}

async function gql(admin: any, query: string, varsOrOptions?: any): Promise<any> {
  const vars = varsOrOptions?.variables !== undefined ? varsOrOptions.variables : varsOrOptions;
  try {
    return await rateLimitedGraphql(admin, query, vars || {});
  } catch (e: any) {
    const msg = e?.message || "";
    if (msg.includes("Unauthorized") || msg.includes("Session not found") || e?.response?.status === 401) {
      console.error(`[Bulk] Auth error en gql: ${msg}`);
      throw new Error(`Token inválido o expirado. Reinstala la app para obtener un nuevo token.`);
    }
    throw e;
  }
}

export async function cancelBulkImport(configId: string, shopDomain: string): Promise<{ success: boolean; message: string }> {
  // Find active BulkJob for this config
  const activeJob = await prisma.bulkJob.findFirst({
    where: { configId, phase: { in: ["lookup", "mutations", "finalizing"] } },
  });
  if (!activeJob) return { success: false, message: "No hay job bulk activo" };

  // Deduplicate sessions before getting admin client
  await ensureSingleSession(shopDomain);

  // Cancel any active ops via Shopify API
  const pendingOps = await prisma.bulkJobOp.findMany({
    where: { jobId: activeJob.id, status: { in: ["pending", "launched", "processing"] } },
  });
  const { admin } = await shopify.unauthenticated.admin(shopDomain);
  for (const op of pendingOps) {
    if (op.shopifyOpId) {
      try {
        await gql(admin, `#graphql
          mutation bulkOperationCancel($id: ID!) {
            bulkOperationCancel(id: $id) {
              bulkOperation { id status }
              userErrors { field message }
            }
          }
        `, { id: op.shopifyOpId });
      } catch {}
    }
  }

  // Update job and ops to cancelled
  await prisma.bulkJob.update({
    where: { id: activeJob.id },
    data: { phase: "failed" },
  });
  await prisma.bulkJobOp.updateMany({
    where: { jobId: activeJob.id, status: { in: ["pending", "launched", "processing"] } },
    data: { status: "failed" },
  });

  // Clean up work directory
  try {
    const workDir = path.join(BASE_WORK_DIR, shopDomain, activeJob.id);
    await fs.rm(workDir, { recursive: true, force: true });
  } catch {}

  return { success: true, message: "Importación bulk cancelada" };
}

const CREATE_MUTATION = `mutation call($input: ProductInput!) { productCreate(input: $input) { product { id title variants { edges { node { id sku barcode inventoryItem { id } } } } } userErrors { field message } } }`;

async function setVariantSkuViaRest(shopDomain: string, productId: string, variantId: string, sku: string): Promise<void> {
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken) {
    console.error(`[Bulk] SKU ${sku}: no session found for ${shopDomain}, skip REST SKU`);
    return;
  }
  const shopId = productId.replace("gid://shopify/Product/", "");
  const varId = variantId.replace("gid://shopify/ProductVariant/", "");
  const url = `https://${shopDomain}/admin/api/2026-07/products/${shopId}/variants/${varId}.json`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": session.accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ variant: { id: Number(varId), sku } }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`REST ${resp.status}: ${body}`);
  }
  console.log(`[Bulk] SKU ${sku}: set via REST PUT`);
}
const UPDATE_MUTATION = `mutation call($input: ProductInput!) { productUpdate(input: $input) { product { id variants { edges { node { id sku barcode inventoryItem { id } } } } } userErrors { field message } } }`;
const LOOKUP_QUERY = `{
  products {
    edges {
      node {
        id
        title
        variants {
          edges {
            node {
              id
              sku
              barcode
              inventoryItem { id unitCost { amount } }
            }
          }
        }
      }
    }
  }
}`;

interface LookupMatch {
  productId: string;
  variantId: string;
  inventoryItemId: string;
  shopifyCost: number;
}

interface MetaLine {
  sku: string;
  ean: string;
  costPrice: number;
  regularPrice: number;
  compareAtPrice: number | null;
  stockQty: number;
  category: string;
  collectionIds: string[];
  productId?: string;
  variantId?: string;
  inventoryItemId?: string;
  priceChanged?: boolean;
  stockChanged?: boolean;
  priceApplied?: boolean;
  stockApplied?: boolean;
  skipPrice?: boolean;
  skipStock?: boolean;
  prevPrice?: number | null;
  prevQty?: number | null;
  replaceMappingId?: string;
  replaceOldConfigId?: string;
  images?: string[];
}

export async function runBulkImport({
  shopDomain,
  triggerType = "scheduled",
  filterType,
  filterSkus,
  filterCategories,
  forceUpdate = false,
  configId,
}: {
  shopDomain: string;
  triggerType?: string;
  filterType?: string;
  filterSkus?: string;
  filterCategories?: string;
  forceUpdate?: boolean;
  configId?: string;
}): Promise<{ bulk: true; jobId: string; logId: string }> {
  let config;
  if (configId) {
    config = await prisma.importConfig.findUnique({ where: { id: configId } });
  } else {
    config = await getOrCreateConfig(shopDomain);
  }

  if (!config) throw new Error("No hay configuración de importación para esta tienda");

  const activeJob = await prisma.bulkJob.findFirst({
    where: { shopDomain, phase: { in: ["lookup", "mutations", "finalizing"] } },
  });
  if (activeJob) {
    throw new Error("Ya hay una importación en curso para esta tienda");
  }

  // CRITICAL: Deduplicate sessions before getting admin client.
  // PrismaSessionStorage upserts by session.id (PK), not by shop.
  // Reinstalls create new rows → stale sessions accumulate → bulk gets 401.
  // ensureSingleSession deletes stale ones and returns the best one.
  const bestSession = await ensureSingleSession(shopDomain);
  if (!bestSession) {
    throw new Error(`No hay sesión para ${shopDomain}. Instala la app desde el admin de Shopify.`);
  }
  console.log(`[Bulk] Best session for ${shopDomain}: id=${bestSession.id}, expires=${bestSession.expires?.toISOString() || "null"}`);

  const { admin } = await shopify.unauthenticated.admin(shopDomain);
  console.log(`[Bulk] Admin client created for ${shopDomain}`);

  // Pre-flight: verify token is valid before starting bulk operation
  try {
    const pingRes = await gql(admin, `{ shop { name } }`);
    if (pingRes.errors?.length) {
      const errMsg = pingRes.errors.map((e: any) => e.message).join(", ");
      console.error(`[Bulk] Pre-flight GQL errors for ${shopDomain}:`, errMsg);
      if (errMsg.includes("Unauthorized") || errMsg.includes("401")) {
        throw new Error(`Token inválido para ${shopDomain}. Reinstala la app para obtener un nuevo token.`);
      }
    } else {
      console.log(`[Bulk] Pre-flight OK for ${shopDomain}, shop: ${pingRes.data?.shop?.name}`);
    }
  } catch (e: any) {
    console.error(`[Bulk] Pre-flight FAILED for ${shopDomain}:`, e?.message || e);
    if (e?.message?.includes("Token inválido") || e?.message?.includes("Session not found") || e?.response?.status === 401) {
      throw new Error(`Token inválido para ${shopDomain}. Reinstala la app para obtener un nuevo token.`);
    }
    throw e;
  }

  await ensureMetafieldDefinitions(admin);
  await getLocationId(admin, shopDomain, config.id);

  const log = await prisma.importLog.create({
    data: {
      shopDomain,
      configId: config.id,
      status: "running",
      triggerType,
    },
  });

  const workDir = path.join(BASE_WORK_DIR, shopDomain, config.id, log.id);
  await fs.mkdir(workDir, { recursive: true });

  const job = await prisma.bulkJob.create({
    data: {
      shopDomain,
      configId: config.id,
      logId: log.id,
      phase: "lookup",
      workDir,
      filterType: filterType || null,
      filterSkus: filterSkus || null,
      filterCategories: filterCategories || null,
      forceUpdate,
    },
  });

  const lookupOp = await runLookupQuery(admin);
  if (!lookupOp.id) {
    throw new Error("No se pudo crear la bulk query de productos existentes");
  }

  await prisma.bulkJobOp.create({
    data: { jobId: job.id, shopifyOpId: lookupOp.id, kind: "lookup", index: 0, status: "launched" },
  });
  await prisma.bulkJob.update({
    where: { id: job.id },
    data: { lookupOpId: lookupOp.id },
  });

  console.log(`[Bulk] Job ${job.id} creado para ${shopDomain}, lookup op ${lookupOp.id}`);
  return { bulk: true, jobId: job.id, logId: log.id };
}

export async function handleBulkOperationFinish({
  admin,
  opId,
  status,
}: {
  admin: any;
  opId: string;
  status: string;
}): Promise<void> {
  console.log(`[Bulk] handleBulkOperationFinish: opId=${opId}, status=${status}`);
  const op = await prisma.bulkJobOp.findUnique({ where: { shopifyOpId: opId } });
  if (!op) {
    console.log(`[Bulk] Webhook de operación desconocida: ${opId}`);
    return;
  }

  const job = await prisma.bulkJob.findUnique({ where: { id: op.jobId } });
  if (!job) {
    console.log(`[Bulk] Job ${op.jobId} no encontrado para op ${opId}`);
    return;
  }

  console.log(`[Bulk] Op ${opId}: kind=${op.kind}, job.phase=${job.phase}, op.status=${op.status}`);

  if (op.kind === "lookup") {
    if (job.phase !== "lookup") {
      console.log(`[Bulk] Lookup webhook ignorado: job.phase=${job.phase} (esperado: lookup)`);
      return;
    }
    await handleLookupFinished(job, admin, status);
    return;
  }

  if (op.kind === "create" || op.kind === "update") {
    if (job.phase !== "mutations") {
      console.log(`[Bulk] Mutation webhook ignorado: job.phase=${job.phase} (esperado: mutations)`);
      return;
    }
    await handleMutationOpFinished(job, op, admin, status);
  }
}

async function handleLookupFinished(job: any, admin: any, status: string): Promise<void> {
  const claim = await prisma.bulkJobOp.updateMany({
    where: { jobId: job.id, kind: "lookup", status: "launched" },
    data: { status: "processing", startedAt: new Date() },
  });
  if (claim.count === 0) return;

  if (status !== "completed") {
    await failJob(job, `La bulk query de productos existentes terminó con estado "${status}"`);
    return;
  }

  const op = await prisma.bulkJobOp.findUnique({
    where: { shopifyOpId: job.lookupOpId },
  });
  const lookupOpId = op?.shopifyOpId || job.lookupOpId;
  if (!lookupOpId) {
    await failJob(job, "Sin ID de bulk query de productos existentes");
    return;
  }

  const lookupPath = path.join(job.workDir, "lookup-result.jsonl");
  await downloadOperationResult(admin, lookupOpId, lookupPath);

  const maps = await buildLookupMaps(lookupPath);
  const sampleSkus = [...maps.bySku.entries()].slice(0, 3);
  console.log(`[Bulk DEBUG] Lookup maps: byBarcode=${maps.byBarcode.size}, bySku=${maps.bySku.size}`);
  for (const [sku, m] of sampleSkus) {
    console.log(`[Bulk DEBUG]   SKU=${sku} → productId=${m.productId}, variantId=${m.variantId}, inventoryItemId=${m.inventoryItemId}`);
  }

  const allMappings = await prisma.productMapping.findMany({
    where: { shopDomain: job.shopDomain },
  });
  const bySkuMapping = new Map<string, { lastPrice: number | null; lastQuantity: number | null; lastCost: number | null }>();
  const orphanSkus: string[] = [];
  for (const m of allMappings) {
    if (!maps.bySku.has(m.supplierSku)) {
      if (m.shopifyProductId) {
        orphanSkus.push(m.supplierSku);
        console.log(`[Bulk] SKU ${m.supplierSku}: mapping huérfano (producto ${m.shopifyProductId} no existe en Shopify), se recreará en este ciclo`);
      }
    } else {
      const existing = maps.bySku.get(m.supplierSku)!;
      if (!existing.inventoryItemId && m.shopifyInventoryItemId) {
        existing.inventoryItemId = m.shopifyInventoryItemId;
      }
      if (!existing.variantId && m.shopifyVariantId) {
        existing.variantId = m.shopifyVariantId;
      }
      bySkuMapping.set(m.supplierSku, {
        lastPrice: m.lastPrice,
        lastQuantity: m.lastQuantity,
        lastCost: m.lastCost ?? null,
      });
    }
  }
  if (orphanSkus.length > 0) {
    await prisma.productMapping.deleteMany({
      where: { shopDomain: job.shopDomain, supplierSku: { in: orphanSkus } },
    });
    console.log(`[Bulk] ${orphanSkus.length} mappings huérfanos eliminados, se recrearán en este ciclo`);
  }

  const baseConfig = await prisma.importConfig.findUnique({ where: { id: job.configId } });
  if (!baseConfig) throw new Error("Config no encontrada para job");
  const config = await prisma.importConfig.findUnique({
    where: { id: baseConfig.id },
    include: { categoryMaps: true },
  });
  if (!config) throw new Error("Configuración no encontrada");

  const sourceKey = getSourceKey(config);
  const columnMaps = (await prisma.columnMapping.findMany({
    where: { configId: config.id, sourceKey },
  })).map((cm) => ({
    shopifyField: cm.shopifyField,
    csvColumn: cm.csvColumn,
    defaultValue: cm.defaultValue,
  }));
  const rules = await getActivePriceRules(job.shopDomain, job.configId);
  const locationId = await getLocationId(admin, job.shopDomain, job.configId);

  await prepareAndLaunch(job, config, admin, columnMaps, rules, maps, bySkuMapping, job.filterType, job.filterSkus, job.filterCategories, locationId);

  await prisma.bulkJobOp.updateMany({
    where: { jobId: job.id, kind: "lookup" },
    data: { status: "processed" },
  });
}

async function prepareAndLaunch(
  job: any,
  config: any,
  admin: any,
  columnMaps: Array<{ shopifyField: string; csvColumn: string | null; defaultValue: string | null }>,
  rules: any[],
  maps: { byBarcode: Map<string, LookupMatch>; bySku: Map<string, LookupMatch> },
  bySkuMapping: Map<string, { lastPrice: number | null; lastQuantity: number | null; lastCost: number | null }>,
  filterType?: string | null,
  filterSkus?: string | null,
  filterCategories?: string | null,
  locationId?: string
): Promise<void> {
  const workDir = job.workDir;
  const updateOpts = parseUpdateOptions(config.updateOptions);
  const createFiles: string[] = [];
  const updateFiles: string[] = [];

  let createLines: string[] = [];
  let createMetas: MetaLine[] = [];
  let createBytes = 0;
  let updateLines: string[] = [];
  let updateMetas: MetaLine[] = [];
  let updateBytes = 0;

  let createFileIndex = 0;
  let updateFileIndex = 0;
  let unchangedCount = 0;
  let updateDebugLogged = 0;
  let totalCount = 0;
  let filteredOutCount = 0;
  let dedupedCount = 0;
  let excludedCount = 0;
  let zeroStockSkippedCount = 0;
  let matchedUpdateCount = 0;
  let matchedUnchangedCount = 0;
  const fieldRules = parseExcludeFieldRules(config.excludeFieldRules);
  let newCreateCount = 0;
  const allSkus: string[] = [];
  const errors: Array<{ sku: string; error: string; lineNumber: number }> = [];
  let duplicateSkippedCount = 0;
  const priorityReplacements: Array<{ mappingId: string; oldConfigId: string; newSku: string; newEan: string }> = [];

  // Pre-load existing EAN mappings from OTHER suppliers for duplicate detection
  const existingEanMappings = new Map<string, { supplierSku: string; configName: string; mappingId: string; configId: string }>();
  // Also preload current supplier's own EANs to avoid self-duplicate false positives
  const selfEanMappings = new Set<string>();
  const shopSettings = await prisma.shopSettings.findUnique({ where: { shopDomain: job.shopDomain } });
  const duplicatePolicy = shopSettings?.duplicatePolicy || "create_both";

  {
    const allEanMappings = await prisma.productMapping.findMany({
      where: {
        shopDomain: job.shopDomain,
        ean: { not: null },
      },
      include: { config: { select: { name: true } } },
    });
    for (const m of allEanMappings) {
      if (!m.ean) continue;
      if (m.configId === config.id) {
        selfEanMappings.add(m.ean);
      } else if (duplicatePolicy !== "create_both") {
        existingEanMappings.set(m.ean, { supplierSku: m.supplierSku, configName: m.config.name, mappingId: m.id, configId: m.configId });
      }
    }
  }

  const flush = async (type: "create" | "update") => {
    if (type === "create") {
      if (createLines.length === 0) return;
      const inputPath = path.join(workDir, `create-input-${createFileIndex}.jsonl`);
      const metaPath = path.join(workDir, `create-meta-${createFileIndex}.jsonl`);
      await fs.writeFile(inputPath, createLines.join("\n") + "\n");
      await fs.writeFile(metaPath, createMetas.map((m) => JSON.stringify(m)).join("\n") + "\n");
      createFiles.push(inputPath);
      createLines = [];
      createMetas = [];
      createBytes = 0;
      createFileIndex++;
    } else {
      if (updateLines.length === 0) return;
      const inputPath = path.join(workDir, `update-input-${updateFileIndex}.jsonl`);
      const metaPath = path.join(workDir, `update-meta-${updateFileIndex}.jsonl`);
      await fs.writeFile(inputPath, updateLines.join("\n") + "\n");
      await fs.writeFile(metaPath, updateMetas.map((m) => JSON.stringify(m)).join("\n") + "\n");
      updateFiles.push(inputPath);
      updateLines = [];
      updateMetas = [];
      updateBytes = 0;
      updateFileIndex++;
    }
  };

  const pushCreate = async (inputObj: any, meta: MetaLine) => {
    const line = JSON.stringify({ input: inputObj });
    createLines.push(line);
    createMetas.push(meta);
    createBytes += Buffer.byteLength(line);
    if (createBytes >= MAX_CHUNK_BYTES) await flush("create");
  };

  const pushUpdate = async (inputObj: any, meta: MetaLine) => {
    const line = JSON.stringify({ input: inputObj });
    updateLines.push(line);
    updateMetas.push(meta);
    updateBytes += Buffer.byteLength(line);
    if (updateBytes >= MAX_CHUNK_BYTES) await flush("update");
  };

  const skuSet = filterSkus
    ? new Set(filterSkus.split(",").map((s) => s.trim().toLowerCase()))
    : null;
  const catSet = filterCategories
    ? new Set(filterCategories.split(",").map((s) => s.trim().toLowerCase()))
    : null;
  const hasAnyFilter = skuSet !== null || catSet !== null;

  const seenSkus = new Set<string>();

  for await (const item of streamFile(getEffectiveUrl(config), config.csvDelimiter)) {
    const { row, lineNumber } = item;
    const sku = (getField(row, columnMaps, "sku") || row["sku"] || "").trim();
    allSkus.push(sku);

    if (!sku) {
      errors.push({ sku: "UNKNOWN", error: "SKU vacío", lineNumber });
      continue;
    }

    const skuLower = sku.toLowerCase();
    const category = (() => {
      const m = columnMaps.find((c) => c.shopifyField === "category");
      if (!m || !m.csvColumn) return m?.defaultValue || "";
      return row[m.csvColumn] || m.defaultValue || "";
    })();

    if (hasAnyFilter) {
      const skuMatch = skuSet?.has(skuLower) ?? false;
      const catMatch = catSet?.has(category.toLowerCase()) ?? false;
      if (!skuMatch && !catMatch) {
        if (filteredOutCount < 3) {
          console.log(`[Bulk DEBUG] SKU=${sku} FILTRADO: skuMatch=${skuMatch} catMatch=${catMatch} skuLower="${skuLower}" category="${category.toLowerCase()}"`);
        }
        filteredOutCount++;
        continue;
      }
    }
    if (seenSkus.has(skuLower)) { dedupedCount++; continue; }
    seenSkus.add(skuLower);

    totalCount++;

    const ean = (() => {
      const mapped = getField(row, columnMaps, "ean");
      if (mapped) return mapped;
      const m = columnMaps.find((c) => c.shopifyField === "ean");
      if (!m || !m.csvColumn) return row["ean"] || row["EAN"] || "";
      return row[m.csvColumn] || row["ean"] || row["EAN"] || "";
    })();

    // Duplicate detection: check if same EAN exists from another supplier OR already in Shopify
    let priorityReplaceMappingId: string | undefined;
    let priorityReplaceConfigId: string | undefined;
    if (ean && duplicatePolicy !== "create_both") {
      const existingDup = existingEanMappings.get(ean);
      if (existingDup) {
        if (duplicatePolicy === "priority") {
          const priorityList = shopSettings?.supplierPriority ? JSON.parse(shopSettings.supplierPriority) : [];
          const currentIndex = priorityList.indexOf(config.id);
          const existingIndex = priorityList.indexOf(existingDup.configId);
          if (currentIndex === -1 || (existingIndex !== -1 && existingIndex <= currentIndex)) {
            // Current supplier has LOWER or equal priority → skip
            await logDuplicate(job.shopDomain, ean, { supplierSku: existingDup.supplierSku, configId: existingDup.configId, config: { name: existingDup.configName }, shopifyProductId: "" }, config.id);
            duplicateSkippedCount++;
            continue;
          }
          // Current supplier has HIGHER priority → mark for replacement
          priorityReplaceMappingId = existingDup.mappingId;
          priorityReplaceConfigId = existingDup.configId;
        } else {
          // skip_existing
          await logDuplicate(job.shopDomain, ean, { supplierSku: existingDup.supplierSku, configId: existingDup.configId, config: { name: existingDup.configName }, shopifyProductId: "" }, config.id);
          duplicateSkippedCount++;
          continue;
        }
      } else if (maps.byBarcode.has(ean) && !selfEanMappings.has(ean)) {
        if (duplicatePolicy === "skip_existing" || duplicatePolicy === "priority") {
          const matchInfo = maps.byBarcode.get(ean);
          await logExternalDuplicate(job.shopDomain, ean, matchInfo?.productId || "", sku, config.id, config.name || "Proveedor");
          duplicateSkippedCount++;
          continue;
        }
      }
    }

    const exclusion = isExcluded(row, columnMaps, config, getField, { sku, ean });
    if (exclusion.excluded) {
      excludedCount++;
      continue;
    }

    const costPrice = parseFloat((getField(row, columnMaps, "price") || "0").replace(",", "."));

    const prices = calculatePriceSync(rules, sku, category, costPrice);

    const quantity = parseInt(
      (() => {
        const m = columnMaps.find((c) => c.shopifyField === "quantity");
        if (!m || !m.csvColumn) return m?.defaultValue || "0";
        return row[m.csvColumn] || m.defaultValue || "0";
      })()
    );
    const stockQty = quantity;

    if (config.skipZeroStockCreate && stockQty <= 0) {
      zeroStockSkippedCount++;
      unchangedCount++;
      continue;
    }

    const matchingCategoryMaps = (config.categoryMaps || [])
      .filter((cm: any) => cm.csvCategory === category && cm.isActive);
    const collectionIds = matchingCategoryMaps.map((cm: any) => cm.collectionId);
    const categoryTags = matchingCategoryMaps.map((cm: any) => cm.tags).filter(Boolean).join(",");
    const shopifyProductType = matchingCategoryMaps.find((cm: any) => cm.shopifyProductType)?.shopifyProductType || null;

    const match = maps.byBarcode.get(ean) || maps.bySku.get(sku);

    const meta: MetaLine = {
      sku,
      ean,
      costPrice,
      regularPrice: prices.regularPrice,
      compareAtPrice: prices.compareAtPrice,
      stockQty,
      category,
      collectionIds,
    };

    if (match) {
      const mapping = bySkuMapping.get(sku);

      const lastPrice = mapping?.lastPrice ?? null;
      const lastQty = mapping?.lastQuantity ?? null;
      const hasVariant = !!match.variantId && !!match.inventoryItemId;

      const excludedFields = getExcludedFields(sku, fieldRules);
      if (excludedFields) {
        console.log(`[Bulk] SKU=${sku} field exclusion: skip=[${excludedFields.join(",")}]`);
      }
      const effectiveOpts = excludedFields
        ? new Set([...updateOpts].filter((o) => !excludedFields.includes(o)))
        : updateOpts;

      const priceChanged =
        effectiveOpts.has("price") && (lastPrice === null || lastPrice !== prices.regularPrice);
      const stockChanged =
        effectiveOpts.has("stock") && hasVariant && (lastQty === null || lastQty !== stockQty);
      const costChanged =
        costPrice > 0 && !!match.inventoryItemId && Math.abs((mapping?.lastCost ?? 0) - costPrice) > 0.001;

      if (updateDebugLogged < 1) {
        updateDebugLogged++;
        console.log(`[Bulk DEBUG] First update SKU=${sku}: inventoryItemId="${match.inventoryItemId}", costPrice=${costPrice}, lastCost=${mapping?.lastCost}, lastPrice=${lastPrice}, csvPrice=${prices.regularPrice}, lastQty=${lastQty}, csvQty=${stockQty}, costChanged=${costChanged}, priceChanged=${priceChanged}, stockChanged=${stockChanged}, hasVariant=${hasVariant}`);
      }

      if (!priceChanged && !stockChanged && !costChanged) {
        matchedUnchangedCount++;
        unchangedCount++;
        continue;
      }

      meta.productId = match.productId;
      meta.variantId = match.variantId;
      meta.inventoryItemId = match.inventoryItemId;
      meta.priceChanged = priceChanged;
      meta.stockChanged = stockChanged;
      meta.priceApplied = priceChanged;
      meta.stockApplied = stockChanged;
      meta.skipPrice = excludedFields?.includes("price") || false;
      meta.skipStock = excludedFields?.includes("stock") || false;
      meta.prevPrice = lastPrice;
      meta.prevQty = lastQty;
      matchedUpdateCount++;

      const inputObj: any = mapCsvRowToBulkUpdateInput(
        row,
        columnMaps,
        prices,
        collectionIds,
        match.variantId,
        effectiveOpts
      );
      inputObj.id = match.productId;
      delete inputObj.variants;
      delete inputObj.seo;

      await pushUpdate(inputObj, meta);
    } else {
      const inputObj = mapCsvRowToBulkCreateInput(
        row,
        columnMaps,
        prices,
        collectionIds,
        config.productStatus,
        locationId,
        config.defaultTags || undefined,
        categoryTags || undefined
      );
      if (shopifyProductType) inputObj.productType = shopifyProductType;
      const images: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const img = getField(row, columnMaps, `image${i}`);
        if (img) images.push(img);
      }
      delete inputObj.files;
      delete inputObj.seo;
      meta.images = images;
      meta.replaceMappingId = priorityReplaceMappingId;
      meta.replaceOldConfigId = priorityReplaceConfigId;
      await pushCreate(inputObj, meta);
      newCreateCount++;
    }
  }

  await flush("create");
  await flush("update");

  console.log(`[Bulk] PREPARE SUMMARY: total=${totalCount}, filtered=${filteredOutCount}, deduped=${dedupedCount}, excluded=${excludedCount}, duplicates=${duplicateSkippedCount}, zeroStockSkip=${zeroStockSkippedCount}, matchedUpdate=${matchedUpdateCount}, matchedUnchanged=${matchedUnchangedCount}, newCreates=${newCreateCount}, unchangedTotal=${unchangedCount}, createFiles=${createFiles.length}, updateFiles=${updateFiles.length}`);

  const allSkusPath = path.join(workDir, "all-skus.jsonl");
  await fs.writeFile(allSkusPath, allSkus.map((s) => JSON.stringify(s)).join("\n") + "\n");

  const errorsPath = path.join(workDir, "errors.jsonl");
  await fs.writeFile(errorsPath, errors.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const priorityReplacementsPath = path.join(workDir, "priority-replacements.jsonl");
  await fs.writeFile(priorityReplacementsPath, priorityReplacements.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const manifest = {
    createFiles,
    updateFiles,
    allSkusPath,
    errorsPath,
    priorityReplacementsPath,
    unchangedCount,
    totalCount,
  };
  const manifestPath = path.join(workDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest));

  // Persistir fase y manifest ANTES de lanzar: si el proceso cae a mitad,
  // el resume (reconcileStaleBulkJobs) puede recuperar las ops pendientes.
  await prisma.bulkJob.update({
    where: { id: job.id },
    data: {
      phase: "mutations",
      manifestPath,
      totalMutationOps: createFiles.length + updateFiles.length,
      totalCount,
      unchangedCount,
      excludedCount: excludedCount + duplicateSkippedCount,
      errorCount: errors.length,
    },
  });

  // Update ImportLog so queue page shows totals immediately (not waiting for first op)
  await prisma.importLog.update({
    where: { id: job.logId },
    data: {
      totalProducts: totalCount,
      unchanged: unchangedCount,
      excludedCount: excludedCount + duplicateSkippedCount,
    },
  }).catch(() => {});

  let launchedCreates = 0;
  let launchedUpdates = 0;

  for (let i = 0; i < createFiles.length; i++) {
    const pending = await prisma.bulkJobOp.create({
      data: { jobId: job.id, kind: "create", index: i, status: "pending" },
    });
    const opId = await stageAndLaunch(admin, CREATE_MUTATION, createFiles[i]);
    await prisma.bulkJobOp.update({
      where: { id: pending.id },
      data: { shopifyOpId: opId, status: "launched" },
    });
    launchedCreates++;
  }

  for (let i = 0; i < updateFiles.length; i++) {
    const pending = await prisma.bulkJobOp.create({
      data: { jobId: job.id, kind: "update", index: i, status: "pending" },
    });
    const opId = await stageAndLaunch(admin, UPDATE_MUTATION, updateFiles[i]);
    await prisma.bulkJobOp.update({
      where: { id: pending.id },
      data: { shopifyOpId: opId, status: "launched" },
    });
    launchedUpdates++;
  }

  console.log(
    `[Bulk] Job ${job.id}: ${totalCount} filas, ${launchedCreates} ops create, ${launchedUpdates} ops update`
  );
}

async function handleMutationOpFinished(job: any, op: any, admin: any, status: string): Promise<void> {
  console.log(`[Bulk] handleMutationOpFinished called: op.kind=${op.kind}, op.index=${op.index}, status=${status}, opId=${op.id}`);
  const claim = await prisma.bulkJobOp.updateMany({
    where: { id: op.id, status: "launched" },
    data: { status: "processing", startedAt: new Date() },
  });
  console.log(`[Bulk] Claim result: count=${claim.count}, current op status after claim query`);
  if (claim.count === 0) {
    const currentOp = await prisma.bulkJobOp.findUnique({ where: { id: op.id }, select: { status: true } });
    console.log(`[Bulk] Claim failed. Op current status: ${currentOp?.status}`);
    return;
  }

  if (status !== "completed") {
    await prisma.bulkJobOp.update({
      where: { id: op.id },
      data: { status: "failed" },
    });
    await failJob(job, `Operación bulk ${op.kind} #${op.index} terminó con estado "${status}"`);
    return;
  }

  const config = await prisma.importConfig.findUnique({ where: { id: job.configId } });
  const manifest = JSON.parse(await fs.readFile(job.manifestPath, "utf-8"));
  const workDir = job.workDir;

  const resultPath = path.join(workDir, `${op.kind}-result-${op.index}.jsonl`);
  console.log(`[Bulk] Downloading result from op ${op.shopifyOpId}...`);
  try {
    await downloadOperationResult(admin, op.shopifyOpId, resultPath);
    console.log(`[Bulk] Download OK to ${resultPath}`);
  } catch (e: any) {
    console.error(`[Bulk] Download FAILED: ${e?.message}`);
    return;
  }

  const metaPath = path.join(workDir, `${op.kind}-meta-${op.index}.jsonl`);
  const metaLines = await readJsonLines(metaPath);
  const resultLines = await readJsonLines(resultPath);
  console.log(`[Bulk] Meta lines: ${metaLines.length}, Result lines: ${resultLines.length}`);

  const inventoryQueuePath = path.join(workDir, "inventory-queue.jsonl");
  const errorsPath = manifest.errorsPath;

  let createdCount = 0;
  let updatedCount = 0;
  let priceChanges = 0;
  let stockChanges = 0;
  let opErrors = 0;
  const inventoryWrites: string[] = [];
  const errorWrites: string[] = [];

  for (let i = 0; i < resultLines.length; i++) {
    const meta = metaLines[i] as MetaLine | undefined;
    const line = resultLines[i] as any;
    if (!meta) continue;

    if (i === 0) {
      console.log(`[Bulk] First result: SKU=${meta.sku}, inventoryItemId=${meta.inventoryItemId}, costPrice=${meta.costPrice}`);
      console.log(`[Bulk] First result line keys: ${JSON.stringify(Object.keys(line))}`);
      console.log(`[Bulk] First result line: ${JSON.stringify(line).substring(0, 500)}`);
    }

    const userErrors = extractUserErrors(line);
    if (userErrors.length > 0 || line.errors) {
      if (i === 0) console.log(`[Bulk] First result HAS ERRORS: ${JSON.stringify(userErrors)}`);
      opErrors++;
      errorWrites.push(
        JSON.stringify({ sku: meta.sku, error: userErrors.join("; ") || "Error de variable", lineNumber: 0 })
      );
      continue;
    }

    if (op.kind === "create") {
      const product = line.data?.productCreate?.product;
      const variant = product?.variants?.edges?.[0]?.node;
      if (!product?.id) {
        opErrors++;
        errorWrites.push(JSON.stringify({ sku: meta.sku, error: "Sin ID de producto en resultado", lineNumber: 0 }));
        continue;
      }

      await prisma.productMapping.upsert({
        where: { shopDomain_supplierSku: { shopDomain: job.shopDomain, supplierSku: meta.sku } },
        create: {
          shopDomain: job.shopDomain,
          configId: job.configId,
          supplierSku: meta.sku,
          ean: meta.ean || null,
          shopifyProductId: product.id,
          shopifyVariantId: variant?.id ?? null,
          shopifyInventoryItemId: variant?.inventoryItem?.id ?? null,
          lastPrice: meta.regularPrice,
          lastComparePrice: meta.compareAtPrice,
          lastQuantity: meta.stockQty,
          lastCost: meta.costPrice > 0 ? meta.costPrice : null,
        },
        update: {
          shopifyProductId: product.id,
          shopifyVariantId: variant?.id ?? null,
          shopifyInventoryItemId: variant?.inventoryItem?.id ?? null,
          lastPrice: meta.regularPrice,
          lastComparePrice: meta.compareAtPrice,
          lastQuantity: meta.stockQty,
        },
      });

      createdCount++;

      if (meta.images && meta.images.length > 0) {
        try {
          const media = meta.images.map((url) => ({
            originalSource: url,
            mediaContentType: "IMAGE" as const,
          }));
          const mediaResult = await gql(admin,
            `#graphql
            mutation productCreateMedia($id: ID!, $media: [CreateMediaInput!]!) {
              productCreateMedia(productId: $id, media: $media) {
                media { ... on MediaImage { id image { url } } }
                mediaUserErrors { field message }
              }
            }`,
            { variables: { id: product.id, media } }
          );
          const mediaErrors = mediaResult.data?.productCreateMedia?.mediaUserErrors;
          if (mediaErrors?.length > 0) {
            console.error(`[Bulk] SKU ${meta.sku}: mediaUserErrors: ${JSON.stringify(mediaErrors)}`);
          } else {
            console.log(`[Bulk] SKU ${meta.sku}: ${meta.images.length} imagen(es) subida(s)`);
          }
        } catch (e: any) {
          console.error(`[Bulk] SKU ${meta.sku}: error subiendo imágenes: ${e?.message}`);
        }
      }

      if (variant?.id) {
        try {
          const variantInput: any = {
            id: variant.id,
            price: String(isNaN(meta.regularPrice) ? 0 : meta.regularPrice),
          };
          if (meta.compareAtPrice && !isNaN(meta.compareAtPrice)) {
            variantInput.compareAtPrice = String(meta.compareAtPrice);
          }
          if (meta.ean) {
            variantInput.barcode = meta.ean;
          }
          await gql(admin,
            `#graphql
            mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                productVariants { id sku barcode price compareAtPrice }
                userErrors { field message }
              }
            }`,
            { variables: { productId: product.id, variants: [variantInput] } }
          );
          console.log(`[Bulk] SKU ${meta.sku}: precio=${meta.regularPrice}${meta.compareAtPrice ? `, compareAt=${meta.compareAtPrice}` : ""}${meta.ean ? `, barcode=${meta.ean}` : ""}`);
        } catch (e: any) {
          console.error(`[Bulk] SKU ${meta.sku}: error seteando precio/barcode: ${e?.message}`);
        }

        if (meta.sku && variant.sku !== meta.sku) {
          try {
            await setVariantSkuViaRest(job.shopDomain, product.id, variant.id, meta.sku);
          } catch (e: any) {
            console.error(`[Bulk] SKU ${meta.sku}: error REST seteando SKU: ${e?.message}`);
          }
        }
      }

      if (variant?.inventoryItem?.id) {
        try {
          const invInput: any = { tracked: true };
          if (meta.costPrice > 0) {
            invInput.cost = String(meta.costPrice);
          }
          await gql(admin,
            `#graphql
            mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
              inventoryItemUpdate(id: $id, input: $input) {
                inventoryItem { id tracked unitCost { amount } }
                userErrors { field message }
              }
            }`,
            {
              variables: {
                id: variant.inventoryItem.id,
                input: invInput,
              },
            }
          );
          console.log(`[Bulk] SKU ${meta.sku}: inventory tracked=true${meta.costPrice > 0 ? `, cost=${meta.costPrice}` : ""}`);
        } catch (e: any) {
          console.error(`[Bulk] SKU ${meta.sku}: error habilitando inventory tracking: ${e?.message}`);
        }

        try {
          const locId = await getLocationId(admin, job.shopDomain, job.configId);
          const actRes = await gql(admin,
            `#graphql
            mutation inventoryBulkToggleActivation($inventoryItemId: ID!, $inventoryItemUpdates: [InventoryBulkToggleActivationInput!]!) {
              inventoryBulkToggleActivation(inventoryItemId: $inventoryItemId, inventoryItemUpdates: $inventoryItemUpdates) {
                inventoryItem { id }
                inventoryLevels { location { id } }
                userErrors { field message code }
              }
            }`,
            {
              variables: {
                inventoryItemId: variant.inventoryItem.id,
                inventoryItemUpdates: [{ locationId: locId, activate: true }],
              },
            }
          );
          const actErrors = actRes.data?.inventoryBulkToggleActivation?.userErrors;
          if (actErrors?.length > 0) {
            console.error(`[Bulk] SKU ${meta.sku}: inventoryBulkToggleActivation errors:`, JSON.stringify(actErrors));
          } else {
            console.log(`[Bulk] SKU ${meta.sku}: inventory activated at location`);
          }
        } catch (e: any) {
          console.error(`[Bulk] SKU ${meta.sku}: error activando inventory en ubicacion: ${e?.message}`);
        }

        inventoryWrites.push(
          JSON.stringify({ inventoryItemId: variant.inventoryItem.id, quantity: meta.stockQty })
        );
      }

      // Publish to selected sales channels (priority) or markets (only on CREATE)
      const allPubIds: string[] = [];
      if (config?.publicationIds) {
        try { allPubIds.push(...JSON.parse(config.publicationIds)); } catch {}
      }
      if (allPubIds.length === 0 && config?.marketIds) {
        try { allPubIds.push(...JSON.parse(config.marketIds)); } catch {}
      }
      if (allPubIds.length > 0) {
        try {
          const input = allPubIds.map((publicationId: string) => ({ publicationId }));
          await gql(admin,
            `#graphql
            mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
              publishablePublish(id: $id, input: $input) {
                userErrors { field message }
              }
            }`,
            { variables: { id: product.id, input } }
          );
          console.log(`[Bulk] SKU ${meta.sku}: publicado en ${allPubIds.length} publicación(es)`);
        } catch (error: any) {
          console.error(`[Bulk] SKU ${meta.sku}: error publicando: ${error?.message}`);
        }
      }
    } else {
      const product = line.data?.productUpdate?.product;
      if (!product?.id) {
        console.log(`[Bulk] SKU ${meta.sku}: producto no encontrado en Shopify, borrando mapping para recrear en próximo cron`);
        await prisma.productMapping.deleteMany({
          where: { shopDomain: job.shopDomain, supplierSku: meta.sku },
        });
        opErrors++;
        errorWrites.push(JSON.stringify({ sku: meta.sku, error: "Producto eliminado de Shopify, mapping borrado", lineNumber: 0 }));
        continue;
      }

      if (updatedCount === 0) {
        console.log(`[Bulk] UPDATE path first product: SKU=${meta.sku}, inventoryItemId=${meta.inventoryItemId}, costPrice=${meta.costPrice}`);
      }

      const patch: any = { shopifyProductId: product.id };
      if (meta.priceApplied) {
        patch.lastPrice = meta.regularPrice;
        patch.lastComparePrice = meta.compareAtPrice;
      }
      if (meta.stockApplied) {
        patch.lastQuantity = meta.stockQty;
      }

      await prisma.productMapping.upsert({
        where: { shopDomain_supplierSku: { shopDomain: job.shopDomain, supplierSku: meta.sku } },
        create: {
          shopDomain: job.shopDomain,
          configId: job.configId,
          supplierSku: meta.sku,
          ean: meta.ean || null,
          shopifyProductId: product.id,
          shopifyVariantId: meta.variantId || null,
          shopifyInventoryItemId: meta.inventoryItemId || null,
          lastPrice: meta.priceApplied ? meta.regularPrice : meta.prevPrice,
          lastComparePrice: meta.priceApplied ? meta.compareAtPrice : null,
          lastQuantity: meta.stockApplied ? meta.stockQty : meta.prevQty,
          lastCost: meta.costPrice > 0 ? meta.costPrice : null,
        },
        update: { ...patch, lastCost: meta.costPrice > 0 ? meta.costPrice : undefined },
      });

      updatedCount++;
      if (meta.priceChanged) {
        priceChanges++;
        if (meta.variantId) {
          try {
            await gql(admin,
              `#graphql
              mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                  productVariants { id price }
                  userErrors { field message }
                }
              }`,
              {
                variables: {
                  productId: product.id,
                  variants: [{
                    id: meta.variantId,
                    price: String(isNaN(meta.regularPrice) ? 0 : meta.regularPrice),
                    ...(meta.compareAtPrice && !isNaN(meta.compareAtPrice) ? { compareAtPrice: String(meta.compareAtPrice) } : {}),
                  }],
                },
              }
            );
          } catch (e: any) {
            console.error(`[Bulk] SKU ${meta.sku}: error actualizando precio: ${e?.message}`);
          }
        }
      }
      if (meta.stockChanged) {
        stockChanges++;
        if (meta.inventoryItemId) {
          inventoryWrites.push(
            JSON.stringify({ inventoryItemId: meta.inventoryItemId, quantity: meta.stockQty, prevQty: meta.prevQty ?? 0 })
          );
        }
      }
      if (meta.inventoryItemId && meta.costPrice > 0 && !meta.skipPrice) {
        console.log(`[Bulk] SKU ${meta.sku}: intentando costo=${meta.costPrice} en inventoryItem=${meta.inventoryItemId}`);
        try {
          const costRes = await gql(admin,
            `#graphql
            mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
              inventoryItemUpdate(id: $id, input: $input) {
                inventoryItem { id unitCost { amount } }
                userErrors { field message }
              }
            }`,
            {
              variables: {
                id: meta.inventoryItemId,
                input: { cost: String(meta.costPrice) },
              },
            }
          );
          if (costRes?.data?.inventoryItemUpdate?.userErrors?.length) {
            console.error(`[Bulk] SKU ${meta.sku}: userErrors seteando costo:`, JSON.stringify(costRes.data.inventoryItemUpdate.userErrors));
          } else {
            console.log(`[Bulk] SKU ${meta.sku}: costo OK = ${costRes?.data?.inventoryItemUpdate?.inventoryItem?.unitCost?.amount}`);
          }
        } catch (e: any) {
          console.error(`[Bulk] SKU ${meta.sku}: error seteando costo: ${e?.message}`);
        }
      } else {
        console.log(`[Bulk] SKU ${meta.sku}: costo NO actualizado - inventoryItemId="${meta.inventoryItemId}", costPrice=${meta.costPrice}`);
      }
    }
  }

  await fs.appendFile(inventoryQueuePath, inventoryWrites.length ? inventoryWrites.join("\n") + "\n" : "");
  await fs.appendFile(errorsPath, errorWrites.length ? errorWrites.join("\n") + "\n" : "");

  await prisma.bulkJobOp.update({
    where: { id: op.id },
    data: { status: "processed" },
  });

  await prisma.bulkJob.update({
    where: { id: job.id },
    data: {
      mutationOpsDone: { increment: 1 },
      createCount: { increment: op.kind === "create" ? createdCount : 0 },
      updateCount: { increment: op.kind === "update" ? updatedCount : 0 },
      priceChanges: { increment: priceChanges },
      stockChanges: { increment: stockChanges },
      errorCount: { increment: opErrors },
    },
  });

  // Update ImportLog progress periodically
  const freshJob = await prisma.bulkJob.findUnique({ where: { id: job.id } });
  if (freshJob) {
    await prisma.importLog.update({
      where: { id: job.logId },
      data: {
        totalProducts: freshJob.totalCount,
        created: freshJob.createCount,
        updated: freshJob.updateCount,
        unchanged: freshJob.unchangedCount,
        excludedCount: freshJob.excludedCount,
      },
    }).catch(() => {});
  }

  const fresh = await prisma.bulkJob.findUnique({ where: { id: job.id } });
  if (fresh && fresh.mutationOpsDone >= fresh.totalMutationOps) {
    await tryFinalize(fresh, admin);
  }
}

// Claim atómico de la fase de finalización para evitar dobles finalizes (webhook + resume a la vez).
async function tryFinalize(job: any, admin: any): Promise<void> {
  const claimed = await prisma.bulkJob.updateMany({
    where: { id: job.id, phase: "mutations" },
    data: { phase: "finalizing" },
  });
  if (claimed.count === 0) return;

  const fresh = await prisma.bulkJob.findUnique({ where: { id: job.id } });
  if (!fresh) return;
  await finalizeBulkImport(fresh, admin);
}

async function finalizeBulkImport(job: any, admin: any): Promise<void> {
  const workDir = job.workDir;
  const manifest = JSON.parse(await fs.readFile(job.manifestPath, "utf-8"));
  const log = await prisma.importLog.findUnique({ where: { id: job.logId } });
  if (!log) return;
  if (log.status !== "running") return; // ya finalizado (idempotencia en resume)

  try {
  const locationId = await getLocationId(admin, job.shopDomain, job.configId);

    const inventoryQueuePath = path.join(workDir, "inventory-queue.jsonl");
    const queue = await readJsonLines(inventoryQueuePath);

    for (let i = 0; i < queue.length; i += 100) {
      const batch = queue.slice(i, i + 100);
      const quantities = batch.map((q: any) => ({
        inventoryItemId: q.inventoryItemId,
        locationId,
        quantity: q.quantity,
        changeFromQuantity: null,
      }));

      try {
        const invRes = await gql(admin,
          `#graphql
          mutation inv($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
            inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
              userErrors { code field message }
              inventoryAdjustmentGroup { id changes { name delta } }
            }
          }`,
          {
            variables: {
              input: {
                reason: "correction",
                name: "available",
                quantities,
              },
              idempotencyKey: `bulk-inv-${job.id}-${i}`,
            },
          }
        );
        const invErrors = invRes.data?.inventorySetQuantities?.userErrors;
        if (invErrors?.length > 0) {
          console.error(`[Bulk] inventorySetQuantities userErrors:`, JSON.stringify(invErrors));
        } else {
          const changes = invRes.data?.inventorySetQuantities?.inventoryAdjustmentGroup?.changes || [];
          console.log(`[Bulk] inventorySetQuantities OK: ${changes.length} cambios`);
        }
      } catch (error: any) {
        console.error("[Bulk] Error ajustando inventario:", error);
      }
    }

    const allSkus = new Set(await readJsonLines(manifest.allSkusPath));
    const hasAnyFilter = !!(job.filterType && job.filterType !== "all");
    const existingMappings = await prisma.productMapping.findMany({
      where: { shopDomain: job.shopDomain, configId: job.configId },
    });

    if (!hasAnyFilter) {
    for (const mapping of existingMappings) {
      if (!allSkus.has(mapping.supplierSku) && (mapping.lastQuantity || 0) > 0) {
        try {
          await gql(admin,
            `#graphql
            mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
              inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
                inventoryAdjustmentGroup { id }
                userErrors { field message code }
              }
            }`,
            {
              variables: {
                input: {
                  reason: "correction",
                  name: "available",
                  changes: [{
                    inventoryItemId: mapping.shopifyInventoryItemId || mapping.shopifyProductId,
                    locationId,
                    delta: -(mapping.lastQuantity || 0),
                    changeFromQuantity: null,
                  }],
                },
                idempotencyKey: `bulk-inv-absent-${mapping.shopifyInventoryItemId || mapping.shopifyProductId}-${locationId}-${Date.now()}`,
              },
            }
          );
          await prisma.productMapping.update({
            where: { id: mapping.id },
            data: { lastQuantity: 0 },
          });
        } catch {
          // no detener la importación
        }
      }
    }
    } // end if (!hasAnyFilter)

    // Process priority replacements: delete old mapping
    if (manifest.priorityReplacementsPath) {
      try {
        const replacements = await readJsonLines(manifest.priorityReplacementsPath);
        for (const rep of replacements) {
          try {
            await prisma.productMapping.delete({ where: { id: rep.mappingId } }).catch(() => {});
            console.log(`[Bulk] Priority replacement: SKU ${rep.newSku} replaced old mapping ${rep.mappingId}`);
          } catch (error: any) {
            console.error(`[Bulk] Priority replacement error for SKU ${rep.newSku}:`, error?.message);
          }
        }
      } catch {
        // priority-replacements.jsonl may not exist
      }
    }

    const errors = await readJsonLines(manifest.errorsPath);
    const status = errors.length > 0 ? "completed_with_errors" : "completed";

    await prisma.importLog.update({
      where: { id: log.id },
      data: {
        status,
        totalProducts: job.totalCount,
        created: job.createCount,
        updated: job.updateCount,
        unchanged: job.unchangedCount,
        priceChanges: job.priceChanges,
        stockChanges: job.stockChanges,
        excludedCount: job.excludedCount,
        errors: errors.length > 0 ? JSON.stringify(errors) : null,
        completedAt: new Date(),
      },
    });

    await prisma.importConfig.update({
      where: { id: job.configId },
      data: { lastImportAt: new Date() },
    });

    await prisma.bulkJob.update({
      where: { id: job.id },
      data: { phase: "done" },
    });

    await sendNotification({
      shopDomain: job.shopDomain,
      status,
      totalProducts: job.totalCount,
      created: job.createCount,
      updated: job.updateCount,
      unchanged: job.unchangedCount,
      priceChanges: job.priceChanges,
      stockChanges: job.stockChanges,
      errors,
      duration: `${Math.round((Date.now() - new Date(log.startedAt).getTime()) / 1000)}s`,
    });

    await cleanupOldLogs(job.configId).catch(() => {});
  } catch (error: any) {
    await failJob(job, error?.message || "Error finalizando importación bulk");
  }
}

async function failJob(job: any, message: string): Promise<void> {
  console.error(`[Bulk] Job ${job.id} fallido: ${message}`);

  await prisma.bulkJob.update({
    where: { id: job.id },
    data: { phase: "failed" },
  });

  const log = await prisma.importLog.findUnique({ where: { id: job.logId } });
  if (log) {
    await prisma.importLog.update({
      where: { id: log.id },
      data: {
        status: "failed",
        errors: JSON.stringify([{ sku: "SYSTEM", error: message, lineNumber: 0 }]),
        completedAt: new Date(),
      },
    });
  }

  await sendNotification({
    shopDomain: job.shopDomain,
    status: "failed",
    totalProducts: job.totalCount,
    created: 0,
    updated: 0,
    unchanged: 0,
    priceChanges: 0,
    stockChanges: 0,
    errors: [{ sku: "SYSTEM", error: message, lineNumber: 0 }],
    duration: "0s",
  });
}

// Limpieza de jobs stuck (sin lookupOpId o manifestPath) que no se resolverán solos
export async function forceCleanupStuckBulkJobs(shopDomain?: string): Promise<{ cleaned: number; details: string[] }> {
  const where: any = {
    phase: { in: ["lookup", "mutations", "finalizing"] },
  };
  if (shopDomain) where.shopDomain = shopDomain;

  const jobs = await prisma.bulkJob.findMany({ where, include: { ops: true } });
  const details: string[] = [];
  let cleaned = 0;

  for (const job of jobs) {
    const ageMs = Date.now() - new Date(job.createdAt).getTime();

    // Jobs stuck in lookup without lookupOpId
    if (job.phase === "lookup" && !job.lookupOpId) {
      const reason = `lookup stuck sin lookupOpId (age=${Math.round(ageMs/60000)}min)`;
      console.log(`[Bulk] Force cleanup: job ${job.id.slice(0,8)} — ${reason}`);
      await prisma.bulkJobOp.deleteMany({ where: { jobId: job.id } });
      await prisma.bulkJob.update({ where: { id: job.id }, data: { phase: "failed" } });
      if (job.workDir) await fs.rm(job.workDir, { recursive: true, force: true }).catch(() => {});
      const log = await prisma.importLog.findUnique({ where: { id: job.logId } });
      if (log && log.status === "running") {
        await prisma.importLog.update({ where: { id: log.id }, data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: reason, lineNumber: 0 }]) } });
      }
      details.push(`Job ${job.id.slice(0,8)}: ${reason}`);
      cleaned++;
      continue;
    }

    // Jobs stuck in mutations without manifestPath
    if (job.phase === "mutations" && !job.manifestPath) {
      const reason = `mutations stuck sin manifestPath (age=${Math.round(ageMs/60000)}min)`;
      console.log(`[Bulk] Force cleanup: job ${job.id.slice(0,8)} — ${reason}`);
      await prisma.bulkJobOp.deleteMany({ where: { jobId: job.id } });
      await prisma.bulkJob.update({ where: { id: job.id }, data: { phase: "failed" } });
      if (job.workDir) await fs.rm(job.workDir, { recursive: true, force: true }).catch(() => {});
      const log = await prisma.importLog.findUnique({ where: { id: job.logId } });
      if (log && log.status === "running") {
        await prisma.importLog.update({ where: { id: log.id }, data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: reason, lineNumber: 0 }]) } });
      }
      details.push(`Job ${job.id.slice(0,8)}: ${reason}`);
      cleaned++;
      continue;
    }

    // Jobs older than 2 hours
    if (ageMs > 2 * 60 * 60 * 1000) {
      const reason = `job stuck demasiado viejo (age=${Math.round(ageMs/60000)}min, phase=${job.phase})`;
      console.log(`[Bulk] Force cleanup: job ${job.id.slice(0,8)} — ${reason}`);
      await prisma.bulkJobOp.deleteMany({ where: { jobId: job.id } });
      await prisma.bulkJob.update({ where: { id: job.id }, data: { phase: "failed" } });
      if (job.workDir) await fs.rm(job.workDir, { recursive: true, force: true }).catch(() => {});
      const log = await prisma.importLog.findUnique({ where: { id: job.logId } });
      if (log && log.status === "running") {
        await prisma.importLog.update({ where: { id: log.id }, data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: reason, lineNumber: 0 }]) } });
      }
      details.push(`Job ${job.id.slice(0,8)}: ${reason}`);
      cleaned++;
    }
  }

  // Also clean running ImportLogs that have no associated queue item
  const orphanLogs = await prisma.importLog.findMany({
    where: { status: "running" },
    orderBy: { startedAt: "asc" },
    take: 20,
  });
  for (const log of orphanLogs) {
    const ageMs = Date.now() - new Date(log.startedAt).getTime();
    if (ageMs > 30 * 60 * 1000) {
      const reason = `orphan ImportLog running por ${Math.round(ageMs/60000)}min`;
      console.log(`[Bulk] Force cleanup: orphan log ${log.id.slice(0,8)} — ${reason}`);
      await prisma.importLog.update({ where: { id: log.id }, data: { status: "failed", completedAt: new Date(), errors: JSON.stringify([{ sku: "SYSTEM", error: reason, lineNumber: 0 }]) } });
      details.push(`Log ${log.id.slice(0,8)}: ${reason}`);
      cleaned++;
    }
  }

  // Clean stale queued importQueue items
  const staleQueued = await prisma.importQueue.deleteMany({
    where: { status: "queued", createdAt: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
  });
  if (staleQueued.count > 0) {
    details.push(`${staleQueued.count} queue items stale eliminados`);
    cleaned += staleQueued.count;
  }

  console.log(`[Bulk] Force cleanup: ${cleaned} items limpiados`);
  return { cleaned, details };
}

export async function reconcileStaleBulkJobs(): Promise<void> {
  const jobs = await prisma.bulkJob.findMany({
    where: { phase: { in: ["lookup", "mutations", "finalizing"] } },
    include: { ops: true },
  });

  if (jobs.length > 0) {
    console.log(`[Bulk] Reconcile: ${jobs.length} active job(s): ${jobs.map((j: any) => `${j.id.slice(0,8)}(${j.phase})`).join(", ")}`);
  }

  for (const job of jobs) {
    const ageMs = Date.now() - new Date(job.updatedAt).getTime();
    if (ageMs < 60_000) continue;

    // If lookup phase has no lookupOpId after 5 minutes, the lookup never completed → fail it
    if (job.phase === "lookup" && !job.lookupOpId && ageMs > 5 * 60 * 1000) {
      console.error(`[Bulk] Job ${job.id.slice(0,8)} stuck in lookup phase with no lookupOpId after ${Math.round(ageMs/60000)}min → failing`);
      await failJob(job, "Lookup nunca completó (posible token inválido). Reinstala la app y vuelve a intentar.");
      continue;
    }

    // If lookup phase has lookupOpId but no mutations after 15 minutes → webhook never arrived
    if (job.phase === "lookup" && job.lookupOpId && ageMs > 15 * 60 * 1000) {
      console.error(`[Bulk] Job ${job.id.slice(0,8)} stuck in lookup phase with lookupOpId=${job.lookupOpId} after ${Math.round(ageMs/60000)}min (webhook never arrived) → failing`);
      await failJob(job, `Webhook BULK_OPERATIONS_FINISH nunca llegó para lookup ${job.lookupOpId}. Verifica que la app esté instalada y los webhooks registrados.`);
      continue;
    }

    // If mutations phase has no manifestPath after 10 minutes → fail it
    if (job.phase === "mutations" && !job.manifestPath && ageMs > 10 * 60 * 1000) {
      console.error(`[Bulk] Job ${job.id.slice(0,8)} stuck in mutations phase with no manifestPath after ${Math.round(ageMs/60000)}min → failing`);
      await failJob(job, "Mutations sin manifest (posible fallo durante preparación).");
      continue;
    }

    // If mutations phase with no progress (mutationOpsDone = 0) after 20 minutes → webhook failing
    if (job.phase === "mutations" && job.manifestPath && (job.mutationOpsDone || 0) === 0 && ageMs > 20 * 60 * 1000) {
      console.error(`[Bulk] Job ${job.id.slice(0,8)} stuck in mutations phase with 0 ops done after ${Math.round(ageMs/60000)}min → failing`);
      await failJob(job, "Mutations sin progreso (webhooks de mutaciones no llegaron). Verifica los webhooks.");
      continue;
    }

    // Any job older than 1 hour → fail it
    if (ageMs > 60 * 60 * 1000) {
      console.error(`[Bulk] Job ${job.id.slice(0,8)} alive for ${Math.round(ageMs/60000)}min → failing (max lifetime exceeded)`);
      await failJob(job, `Job excedió tiempo máximo de vida (${Math.round(ageMs/60000)}min).`);
      continue;
    }

    try {
      console.log(`[Bulk] Reconcile: resuming job ${job.id.slice(0,8)} (phase=${job.phase}, age=${Math.round(ageMs/1000)}s)`);
      if (job.phase === "lookup") {
        await reconcileLookupPhase(job);
      } else if (job.phase === "mutations") {
        await reconcileMutationsPhase(job);
      } else if (job.phase === "finalizing") {
        await ensureSingleSession(job.shopDomain);
        const { admin } = await shopify.unauthenticated.admin(job.shopDomain);
        console.log(`[Bulk] Reconcile finalizing: admin client created for ${job.shopDomain}`);
        await finalizeBulkImport(job, admin);
      }
    } catch (error: any) {
      const msg = error?.message || "";
      const isAuth = msg.includes("Token inválido") || msg.includes("Session not found") || msg.includes("Unauthorized") || msg.includes("No se pudo crear admin client");
      console.error(
        `[Bulk] Error reanudando job ${job.id} (fase ${job.phase}):`,
        msg || error
      );
      if (isAuth) {
        console.error(`[Bulk] Auth error in reconcile → failing job ${job.id.slice(0,8)}: ${msg}`);
        await failJob(job, `Token inválido: ${msg}. Reinstala la app para obtener un nuevo token.`);
      }
      // Non-auth errors: log but continue to next reconcile cycle
    }
  }
}

const STALE_PROCESSING_MS = 10 * 60 * 1000;

// Limpia jobs bulk terminados (done/failed) más antiguos que la retención:
// borra sus ops de la BD, las filas de BulkJob y los directorios de trabajo del disco.
export async function cleanupFinishedBulkJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - JOB_RETENTION_MS);

  const jobs = await prisma.bulkJob.findMany({
    where: {
      phase: { in: ["done", "failed"] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, workDir: true },
  });

  if (jobs.length === 0) return 0;

  const jobIds = jobs.map((j) => j.id);

  await prisma.bulkJobOp.deleteMany({ where: { jobId: { in: jobIds } } });
  await prisma.bulkJob.deleteMany({ where: { id: { in: jobIds } } });

  for (const job of jobs) {
    await fs.rm(job.workDir, { recursive: true, force: true }).catch((error: any) =>
      console.error(`[Bulk] No se pudo borrar ${job.workDir}:`, error?.message || error)
    );
  }

  console.log(`[Bulk] Limpieza: eliminados ${jobs.length} jobs bulk terminados`);
  return jobs.length;
}

// Si una op quedó en "processing" (crash a mitad del procesado), la vuelve a "launched"
// para que un claim atómico pueda retomarla.
async function resetStaleProcessing(row: any): Promise<boolean> {
  if (!row || row.status !== "processing" || !row.startedAt) return false;
  if (Date.now() - new Date(row.startedAt).getTime() <= STALE_PROCESSING_MS) return false;
  await prisma.bulkJobOp.update({
    where: { id: row.id },
    data: { status: "launched", startedAt: null },
  });
  return true;
}

async function reconcileLookupPhase(job: any): Promise<void> {
  // Deduplicate sessions before getting admin client
  const bestSession = await ensureSingleSession(job.shopDomain);
  const isExpired = bestSession?.expires ? new Date(bestSession.expires) < new Date() : true;
  console.log(`[Bulk] Reconcile lookup: shop=${job.shopDomain}, sessionExpired=${isExpired}, accessToken=${bestSession?.accessToken ? "present" : "MISSING"}`);

  if (!bestSession) {
    console.error(`[Bulk] Reconcile lookup: No session for ${job.shopDomain}, aborting`);
    return;
  }

  const { admin } = await shopify.unauthenticated.admin(job.shopDomain);

  const lookupRow =
    job.ops.find((o: any) => o.kind === "lookup" && o.shopifyOpId === job.lookupOpId) ||
    job.ops.find((o: any) => o.kind === "lookup");

  if (!lookupRow || !lookupRow.shopifyOpId) {
    // Crash justo después de crear el job, antes de lanzar/registrar la lookup.
    const op = await runLookupQuery(admin);
    if (!op.id) {
      await failJob(job, "No se pudo lanzar la bulk query de productos existentes (resume)");
      return;
    }
    if (lookupRow) {
      await prisma.bulkJobOp.update({
        where: { id: lookupRow.id },
        data: { shopifyOpId: op.id, status: "launched" },
      });
    } else {
      await prisma.bulkJobOp.create({
        data: { jobId: job.id, shopifyOpId: op.id, kind: "lookup", index: 0, status: "launched" },
      });
    }
    await prisma.bulkJob.update({
      where: { id: job.id },
      data: { lookupOpId: op.id },
    });
    return;
  }

  await resetStaleProcessing(lookupRow);

  const bulk = await getBulkOperation(admin, lookupRow.shopifyOpId);
  if (!bulk) return;

  const status = (bulk.status || "").toLowerCase();
  if (["completed", "failed", "canceled"].includes(status)) {
    await handleBulkOperationFinish({ admin, opId: lookupRow.shopifyOpId, status });
  }
}

async function reconcileMutationsPhase(job: any): Promise<void> {
  if (!job.manifestPath) {
    await failJob(job, "Job en fase mutations sin manifest (resume): imposible reanudar");
    return;
  }

  // Deduplicate sessions before getting admin client
  const bestSession = await ensureSingleSession(job.shopDomain);
  const isExpired = bestSession?.expires ? new Date(bestSession.expires) < new Date() : true;
  console.log(`[Bulk] Reconcile mutations: shop=${job.shopDomain}, sessionExpired=${isExpired}, accessToken=${bestSession?.accessToken ? "present" : "MISSING"}`);

  if (!bestSession) {
    await failJob(job, `No hay sesión para ${job.shopDomain}. Instala la app desde el admin.`);
    return;
  }

  const { admin } = await shopify.unauthenticated.admin(job.shopDomain);
  const manifest = JSON.parse(await fs.readFile(job.manifestPath, "utf-8"));

  const filesByKey = new Map<string, string>();
  manifest.createFiles.forEach((f: string, i: number) => filesByKey.set(`create-${i}`, f));
  manifest.updateFiles.forEach((f: string, i: number) => filesByKey.set(`update-${i}`, f));

  const opsByKey = new Map<string, any>();
  for (const op of job.ops) {
    if (op.kind !== "create" && op.kind !== "update") continue;
    opsByKey.set(`${op.kind}-${op.index}`, op);
  }

  for (const [key, inputPath] of filesByKey) {
    const op = opsByKey.get(key);
    const kind = key.split("-")[0] as "create" | "update";
    const index = Number(key.split("-")[1]);

    if (!op) {
      // Crash antes de registrar la op (fase ya en mutations pero fila perdida).
      await resumeMissingMutationOp(job, admin, kind, index, inputPath);
      continue;
    }

    if (op.status === "processed") continue;

    await resetStaleProcessing(op);

    if (!op.shopifyOpId) {
      // Ruta pending: verificar antes de relanzar (solo creates; updates son idempotentes).
      await resumePendingMutationOp(job, admin, op, kind, index, inputPath);
      continue;
    }

    const bulk = await getBulkOperation(admin, op.shopifyOpId);
    if (!bulk) continue;

    const status = (bulk.status || "").toLowerCase();
    if (["completed", "failed", "canceled"].includes(status)) {
      await handleBulkOperationFinish({ admin, opId: op.shopifyOpId, status });
    }
  }

  const allProcessed = [...filesByKey.keys()].every((key) => {
    const existingOp = opsByKey.get(key);
    return existingOp && existingOp.status === "processed";
  });

  if (allProcessed && job.phase === "mutations") {
    await tryFinalize(job, admin);
  }
}

async function resumeMissingMutationOp(
  job: any,
  admin: any,
  kind: "create" | "update",
  index: number,
  inputPath: string
): Promise<void> {
  if (kind === "update") {
    const opId = await stageAndLaunch(admin, UPDATE_MUTATION, inputPath);
    await prisma.bulkJobOp.create({
      data: { jobId: job.id, shopifyOpId: opId, kind, index, status: "launched" },
    });
    return;
  }

  await resumeOrRebuildCreateOp(job, admin, { opId: null, index, inputPath });
}

async function resumePendingMutationOp(
  job: any,
  admin: any,
  op: any,
  kind: "create" | "update",
  index: number,
  inputPath: string
): Promise<void> {
  if (kind === "update") {
    // productUpdate es idempotente: relanzar es seguro aunque exista una op fantasma.
    const opId = await stageAndLaunch(admin, UPDATE_MUTATION, inputPath);
    await prisma.bulkJobOp.update({
      where: { id: op.id },
      data: { shopifyOpId: opId, status: "launched" },
    });
    return;
  }

  await resumeOrRebuildCreateOp(job, admin, { opId: op.id, index, inputPath });
}

// Resume seguro de un create pendiente:
// 1. Si hay una op fantasma (mutation op desconocida del mismo job) en curso → esperar.
// 2. Consultar los SKUs del fichero contra Shopify: los que ya existen fueron creados
//    por la op fantasma → se adoptan (ProductMapping + inventario), sin relanzar.
// 3. Reconstruir el fichero con SOLO los SKUs que faltan y lanzarlo. Esto elimina la
//    ventana de duplicados: nunca se relanza un SKU que ya existe.
async function resumeOrRebuildCreateOp(
  job: any,
  admin: any,
  target: { opId: string | null; index: number; inputPath: string }
): Promise<void> {
  const { index, inputPath } = target;
  const workDir = job.workDir;
  const metaPath = path.join(workDir, `create-meta-${index}.jsonl`);

  const ghosts = await findGhostMutationOps(job, admin);
  if (ghosts.some((g) => g.status === "CREATED" || g.status === "RUNNING")) {
    return; // la op fantasma puede seguir creando: esperar al siguiente ciclo
  }

  const metas = (await readJsonLines(metaPath)) as MetaLine[];
  const skus = metas.map((m) => m.sku).filter(Boolean);
  const existing = await lookupSkusSync(admin, skus);

  const rawInput = await fs.readFile(inputPath, "utf-8").catch(() => "");
  const inputLines = rawInput.split("\n").filter((l) => l.trim());

  const adopted: MetaLine[] = [];
  const missing: Array<{ meta: MetaLine; line: string }> = [];
  const inventoryWrites: string[] = [];

  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i];
    const match = existing.get(meta.sku) || existing.get(meta.ean);
    if (match) {
      adopted.push(meta);
      await prisma.productMapping.upsert({
        where: { shopDomain_supplierSku: { shopDomain: job.shopDomain, supplierSku: meta.sku } },
        create: {
          shopDomain: job.shopDomain,
          configId: job.configId,
          supplierSku: meta.sku,
          ean: meta.ean || null,
          shopifyProductId: match.productId,
          shopifyVariantId: match.variantId || null,
          shopifyInventoryItemId: match.inventoryItemId || null,
          lastPrice: meta.regularPrice,
          lastComparePrice: meta.compareAtPrice,
          lastQuantity: meta.stockQty,
          lastCost: meta.costPrice > 0 ? meta.costPrice : null,
        },
        update: {
          shopifyProductId: match.productId,
          shopifyVariantId: match.variantId || null,
          shopifyInventoryItemId: match.inventoryItemId || null,
          lastPrice: meta.regularPrice,
          lastComparePrice: meta.compareAtPrice,
          lastQuantity: meta.stockQty,
          lastCost: meta.costPrice > 0 ? meta.costPrice : undefined,
        },
      });
      if (match.inventoryItemId) {
        inventoryWrites.push(
          JSON.stringify({ inventoryItemId: match.inventoryItemId, quantity: meta.stockQty, prevQty: meta.prevQty ?? 0 })
        );
        if (meta.costPrice > 0) {
          try {
            await gql(admin,
              `#graphql
              mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
                inventoryItemUpdate(id: $id, input: $input) {
                  inventoryItem { id unitCost { amount } }
                  userErrors { field message }
                }
              }`,
              {
                variables: {
                  id: match.inventoryItemId,
                input: { cost: String(meta.costPrice) },
                },
              }
            );
          } catch (e: any) {
            console.error(`[Bulk] SKU ${meta.sku}: error seteando costo en adoptado: ${e?.message}`);
          }
        }
      }
    } else {
      missing.push({ meta, line: inputLines[i] || JSON.stringify({ input: {} }) });
    }
  }

  if (adopted.length > 0) {
    await fs.appendFile(
      path.join(workDir, "inventory-queue.jsonl"),
      inventoryWrites.join("\n") + "\n"
    );
    await prisma.bulkJob.update({
      where: { id: job.id },
      data: { createCount: { increment: adopted.length } },
    });
  }

  // Todos existían → la op fantasma los creó: no relanzar nada.
  if (missing.length === 0) {
    if (target.opId) {
      await prisma.bulkJobOp.update({
        where: { id: target.opId },
        data: { status: "processed" },
      });
    }
    return;
  }

  // Reconstruir el fichero solo con los SKUs que faltan (alineación línea↔meta intacta).
  await fs.writeFile(inputPath, missing.map((m) => m.line).join("\n") + "\n");
  await fs.writeFile(metaPath, missing.map((m) => JSON.stringify(m.meta)).join("\n") + "\n");

  const opId = await stageAndLaunch(admin, CREATE_MUTATION, inputPath);
  if (target.opId) {
    await prisma.bulkJobOp.update({
      where: { id: target.opId },
      data: { shopifyOpId: opId, status: "launched" },
    });
  } else {
    await prisma.bulkJobOp.create({
      data: { jobId: job.id, shopifyOpId: opId, kind: "create", index, status: "launched" },
    });
  }
}

// Operaciones MUTATION recientes del job que no conocemos en DB → candidatas a "op fantasma".
async function findGhostMutationOps(
  job: any,
  admin: any
): Promise<Array<{ id: string; status: string; createdAt: string }>> {
  const recent = await listRecentMutationOps(admin);
  const known = new Set<string>();
  for (const op of job.ops) {
    if (op.shopifyOpId) known.add(op.shopifyOpId);
  }
  const jobStart = new Date(job.createdAt).getTime();
  return recent.filter((o) => {
    if (known.has(o.id)) return false;
    return new Date(o.createdAt).getTime() >= jobStart;
  });
}

async function listRecentMutationOps(
  admin: any
): Promise<Array<{ id: string; status: string; createdAt: string }>> {
  const json = await gql(admin,
    `#graphql
    query {
      bulkOperations(first: 50, query: "operation_type:MUTATION", sortKey: CREATED_AT, reverse: true) {
        edges {
          node { id status createdAt }
        }
      }
    }`
  );
  return (json.data?.bulkOperations?.edges || []).map((e: any) => e.node);
}

// Lookup síncrono y acotado a los SKUs indicados (solo en recuperación).
async function lookupSkusSync(admin: any, skus: string[]): Promise<Map<string, LookupMatch>> {
  const result = new Map<string, LookupMatch>();
  const unique = [...new Set(skus)].filter(Boolean);

  const batchSize = 50;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const query = batch.map((sku) => `sku:'${String(sku).replace(/'/g, "")}'`).join(" OR ");

    const json = await gql(admin,
      `#graphql
      query ($q: String!) {
        products(first: 100, query: $q) {
          edges {
            node {
              id
              variants(first: 5) {
                edges {
                  node { id sku barcode inventoryItem { id } }
                }
              }
            }
          }
        }
      }`,
      { variables: { q: query } }
    );

    for (const edge of json.data?.products?.edges || []) {
      const productId = edge.node.id;
      for (const vEdge of edge.node.variants?.edges || []) {
        const variant = vEdge.node;
        const match: LookupMatch = {
          productId,
          variantId: variant.id,
          inventoryItemId: variant.inventoryItem?.id || "",
          shopifyCost: 0,
        };
        if (variant.sku) result.set(String(variant.sku), match);
        if (variant.barcode) result.set(String(variant.barcode), match);
      }
    }
  }

  return result;
}

// --- Helpers de Shopify ---

async function runLookupQuery(admin: any) {
  const json = await gql(admin,
    `#graphql
    mutation bulkOp($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { variables: { query: LOOKUP_QUERY } }
  );
  const userErrors = json.data?.bulkOperationRunQuery?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e: any) => e.message).join(", "));
  }
  return json.data?.bulkOperationRunQuery?.bulkOperation || {};
}

async function getBulkOperation(admin: any, id: string) {
  const json = await gql(admin,
    `#graphql
    query bulkOp($id: ID!) {
      bulkOperation(id: $id) {
        id status errorCode completedAt objectCount fileSize url partialDataUrl
      }
    }`,
    { variables: { id } }
  );
  return json.data?.bulkOperation;
}

async function downloadOperationResult(admin: any, opId: string, targetPath: string): Promise<void> {
  const op = await getBulkOperation(admin, opId);
  const url = op?.url || op?.partialDataUrl;
  if (!url) {
    throw new Error(`Operación bulk ${opId} sin URL de resultados (status ${op?.status})`);
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Error descargando resultados de ${opId}: ${response.status}`);
  }

  const stream = createWriteStream(targetPath);
  for await (const chunk of Readable.fromWeb(response.body as any)) {
    if (!stream.write(chunk)) {
      await new Promise<void>((resolve) => stream.once("drain", resolve));
    }
  }
  await new Promise<void>((resolve, reject) => {
    stream.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

async function stageAndLaunch(admin: any, mutation: string, inputPath: string): Promise<string> {
  const content = await fs.readFile(inputPath);

  let staged;
  try {
    staged = await gql(admin,
      `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          userErrors { field message }
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
        }
      }`,
      {
        variables: {
          input: [
            {
              resource: "BULK_MUTATION_VARIABLES",
              filename: "import.jsonl",
              mimeType: "text/jsonl",
              httpMethod: "POST",
            },
          ],
        },
      }
    );
  } catch (e: any) {
    const msg = e?.message || "";
    if (msg.includes("Unauthorized") || msg.includes("Session not found") || e?.response?.status === 401) {
      throw new Error(`Token expirado durante staged upload. Reinstala la app para obtener un nuevo token.`);
    }
    throw e;
  }
  const target = staged.data?.stagedUploadsCreate?.stagedTargets?.[0];
  const stagedErrors = staged.data?.stagedUploadsCreate?.userErrors || [];
  if (!target || stagedErrors.length > 0) {
    throw new Error(`Error reservando upload: ${stagedErrors.map((e: any) => e.message).join(", ")}`);
  }

  const form = new FormData();
  for (const param of target.parameters || []) {
    form.append(param.name, param.value);
  }
  form.append("file", new Blob([content]), "import.jsonl");

  const uploadResponse = await fetch(target.url, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    throw new Error(`Error subiendo JSONL: ${uploadResponse.status} ${uploadResponse.statusText}`);
  }

  const key = (target.parameters || []).find((p: any) => p.name === "key")?.value;
  if (!key) throw new Error("Sin stagedUploadPath (key) en la respuesta");

  let launch;
  try {
    launch = await gql(admin,
      `#graphql
      mutation bulkOp($mutation: String!, $stagedUploadPath: String!) {
        bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
          bulkOperation { id status }
          userErrors { field message }
        }
      }`,
      { variables: { mutation, stagedUploadPath: key } }
    );
  } catch (e: any) {
    const msg = e?.message || "";
    if (msg.includes("Unauthorized") || msg.includes("Session not found") || e?.response?.status === 401) {
      throw new Error(`Token expirado durante bulkOperationRunMutation. Reinstala la app para obtener un nuevo token.`);
    }
    throw e;
  }
  const launchErrors = launch.data?.bulkOperationRunMutation?.userErrors || [];
  if (launchErrors.length > 0) {
    throw new Error(launchErrors.map((e: any) => e.message).join(", "));
  }
  const opId = launch.data?.bulkOperationRunMutation?.bulkOperation?.id;
  if (!opId) throw new Error("No se devolvió ID de la bulk operation");
  return opId;
}

// --- Helpers de datos ---

async function readJsonLines(filePath: string): Promise<any[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function buildLookupMaps(lookupPath: string): Promise<{
  byBarcode: Map<string, LookupMatch>;
  bySku: Map<string, LookupMatch>;
}> {
  const byBarcode = new Map<string, LookupMatch>();
  const bySku = new Map<string, LookupMatch>();
  const variantIds = new Map<string, LookupMatch>();

  let currentProductId = "";
  const allLines = await readJsonLines(lookupPath);

  for (const line of allLines) {
    if (!line.__parentId) {
      currentProductId = line.id || "";
      continue;
    }

    const parentId = line.__parentId;
    const id = line.id || "";
    if (!id) continue;

    if (variantIds.has(parentId)) {
      const existing = variantIds.get(parentId)!;
      if (!existing.inventoryItemId) {
        existing.inventoryItemId = line.id || "";
      }
      continue;
    }

    if (!line.sku && !line.barcode) continue;

    const skuStr = String(line.sku || "").trim();
    if (skuStr && /^\d+[\.,]\d+\s*€?$/.test(skuStr)) continue;

    const match: LookupMatch = {
      productId: currentProductId,
      variantId: id,
      inventoryItemId: line.inventoryItem?.id || "",
      shopifyCost: parseFloat(line.inventoryItem?.unitCost?.amount ?? "0") || 0,
    };

    variantIds.set(id, match);
    if (line.barcode) byBarcode.set(String(line.barcode), match);
    if (line.sku) bySku.set(String(line.sku), match);
  }

  return { byBarcode, bySku };
}

function extractUserErrors(line: any): string[] {
  if (!line) return [];
  if (line.errors) {
    return (line.errors as any[]).map((e: any) => e.message || "Error");
  }
  const data = line.data;
  if (!data) return [];
  const createErrors = data.productCreate?.userErrors;
  const updateErrors = data.productUpdate?.userErrors;
  const errors = createErrors || updateErrors || [];
  return (errors as any[]).map((e: any) => e.message || "Error");
}
