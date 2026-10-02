import { AsyncLocalStorage } from "node:async_hooks";
import { prisma, getOrCreateConfig, getEffectiveUrl, getSourceKey, cleanupOldLogs, refreshAccessToken } from "./db.server";
import { resolveFileUrl } from "./storage.server";
import { streamFile, isExcluded, parseExcludeFieldRules, getExcludedFields } from "./csv-parser.server";
import { calculatePrices } from "./price-rules.server";
import { mapCsvRowToProductSet, parseUpdateOptions, getField } from "./product-mapper.server";
import { getLocationId } from "./location.server";
import { checkDuplicate, logExternalDuplicate } from "./duplicate-detection.server";
import { rateLimitedGraphql } from "./import-locks.server";
import { ensureMetafieldDefinitions } from "./metafield-definitions";
import shopify from "~/shopify.server";

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  eacute: "é", agrave: "à", auml: "ä", ouml: "ö", uuml: "ü",
  ccordil: "ç", ntide: "ñ", iquest: "¿", iexcl: "¡", times: "×",
  divide: "÷", euro: "€", pound: "£", cent: "¢", copy: "©",
  reg: "®", trade: "™", mdash: "—", ndash: "–", lsquo: "'", rsquo: "'",
  ldquo: '"', rdquo: '"', bull: "•", middot: "·", hellip: "…",
  laquo: "«", raquo: "»", para: "§", micro: "µ", acute: "´",
  cedil: "¸", tilde: "~", circ: "ˆ", deg: "°", brvbar: "¦",
  sect: "§", curren: "¤", yen: "¥", not: "¬",
  shy: "\u00AD", macr: "¯",
};
function normalizeHtml(html: string): string {
  if (!html) return "";
  return html
    .normalize("NFC")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(\w+);/g, (_, name) => HTML_ENTITY_MAP[name] ?? " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B\u200C\u200D\u00AD\u2060\uFEFF]/g, "")
    .replace(/[^a-záéíóúñüàèìòùäëïöûçñ0-9\s]/gi, " ")
    .replace(/\bwi\s+fi\b/gi, "wifi")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function descriptionsMatch(a: string, b: string): boolean {
  return normalizeHtml(a) === normalizeHtml(b);
}

// El feed trae ZWSP (\u200b) en algunos títulos; Shopify lo elimina al guardar.
// Sin esta limpieza la comparación title csv vs live nunca empata → update fantasma cada run.
function stripInvisible(s: string | null): string {
  return (s ?? "").replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "").trim();
}

function normalizeTags(tags: string[]): string {
  return JSON.stringify(tags.map((t) => t.trim().toLowerCase()).sort());
}

interface BarcodeMatch {
  productId: string;
  variantId: string;
  sku: string;
}

// A1: contexto por-tienda para GraphQL (AsyncLocalStorage — docs Node: Stability 2;
// run()/getStore() propagan el store por toda la cadena async creada dentro del
// callback, incluidos worker pool y sleeps). ANTES había un único _adminRef /
// _shopDomainRef global: con 2 tiendas importando a la vez, las mutaciones de la
// tienda A usaban el admin de la tienda B (escritura en el store equivocado).
// Fuera de un contexto (p.ej. llamadas sueltas desde bulk/webhooks) getStore()
// devuelve undefined y graphqlWithRetry usa el admin que le pasa el llamante,
// que siempre es el de su propia tienda.
type ImportGraphqlCtx = { shopDomain: string; adminRef: { current: any } };
const _importCtx = new AsyncLocalStorage<ImportGraphqlCtx>();

// N2: throttle de refresh de token (espejo de bulk gql: lastRefreshAt 30s)
// Evita que el worker pool dispare N refreshes OAuth simultáneos con 401 en ráfaga.
const _lastRefreshAt = new Map<string, number>();
const MIN_REFRESH_INTERVAL_MS = 30_000;

// Ejecuta fn con contexto de tienda solo si aún no lo hay (entrada desde bulk
// o webhooks); si ya existe (ruta chunks) se reutiliza para conservar el admin
// refrescado mid-import.
function withShopCtx<T>(shopDomain: string | undefined | null, admin: any, fn: () => Promise<T>): Promise<T> {
  if (!shopDomain || _importCtx.getStore()) return fn();
  return _importCtx.run({ shopDomain, adminRef: { current: admin } }, fn);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// M2: lookup POR LOTE (por chunk de filas) en vez de precarga del catálogo entero.
// Doc oficial verificada: (1) paginación de connections tope 25.000 objetos → la
// precarga anterior NO podía siquiera recorrer tiendas grandes (y además tenía un
// hardcode de 50 páginas = 12.500 productos); (2) input arrays ≤250 y syntax
// field:value OR field:value (search-syntax) → batches de 15 SKUs / 50 EANs;
// (3) products(first:N) connection cuesta N pts → lookup ligero con first:100/250.
// Memoria O(chunk de 50 filas) — sin Map de todo el catálogo en RAM.
async function lookupBarcodeMatchesForChunk(
  admin: any,
  skus: string[],
  eans: string[]
): Promise<Map<string, BarcodeMatch>> {
  const map = new Map<string, BarcodeMatch>();
  const uniqueSkus = [...new Set(skus.map((s) => s.trim()).filter(Boolean))];
  const uniqueEans = [...new Set(eans.map((e) => e.trim()).filter(Boolean))];

  const PRODUCT_QUERY = `#graphql
    query ($q: String!) {
      products(first: 100, query: $q) {
        edges {
          node {
            id
            variants(first: 10) {
              edges { node { id sku barcode } }
            }
          }
        }
      }
    }`;

  const VARIANT_QUERY = `#graphql
    query ($q: String!) {
      productVariants(first: 250, query: $q) {
        edges { node { id sku barcode product { id } } }
      }
    }`;

  const failedBatches: string[][] = [];

  // SKUs → products(query: "sku:'A' OR sku:'B' ...") en batches de 15
  for (let i = 0; i < uniqueSkus.length; i += 15) {
    const batch = uniqueSkus.slice(i, i + 15);
    const query = batch.map((s) => `sku:'${String(s).replace(/'/g, "")}'`).join(" OR ");
    try {
      const json: any = await graphqlWithRetry(admin, PRODUCT_QUERY, { q: query });
      for (const edge of json.data?.products?.edges || []) {
        const node = edge.node;
        for (const vEdge of node.variants?.edges || []) {
          const v = vEdge.node;
          const match: BarcodeMatch = { productId: node.id, variantId: v.id, sku: v.sku || "" };
          if (v.barcode) map.set(String(v.barcode), match);
          if (v.sku && !map.has(String(v.sku))) map.set(String(v.sku), match);
        }
      }
    } catch (e: any) {
      failedBatches.push(batch);
      console.error(`[Import] Chunk lookup SKU batch failed: ${batch.join(",")} → ${e?.message}`);
    }
  }

  // EANs que el lookup por SKU no encontró → productVariants(barcode:...) en batches de 50
  const pendingEans = uniqueEans.filter((e) => !map.has(e));
  for (let i = 0; i < pendingEans.length; i += 50) {
    const batch = pendingEans.slice(i, i + 50);
    const query = batch.map((e) => `barcode:${String(e).replace(/'/g, "")}`).join(" OR ");
    try {
      const json: any = await graphqlWithRetry(admin, VARIANT_QUERY, { q: query });
      for (const edge of json.data?.productVariants?.edges || []) {
        const v = edge.node;
        const match: BarcodeMatch = { productId: v.product?.id || "", variantId: v.id, sku: v.sku || "" };
        if (v.barcode) map.set(String(v.barcode), match);
        if (v.sku && !map.has(String(v.sku))) map.set(String(v.sku), match);
      }
    } catch (e: any) {
      failedBatches.push(batch);
      console.error(`[Import] Chunk lookup EAN batch failed: ${batch.join(",")} → ${e?.message}`);
    }
  }

  // Misma regla que bulk: el lookup debe completar fully. Si un batch falla,
  // abortamos el import en vez de arriesgar crear duplicados con detección incompleta.
  if (failedBatches.length > 0) {
    const n = failedBatches.flat().length;
    throw new Error(`Lookup incompleto: ${n} claves no pudieron consultarse tras reintentos → import abortado para evitar duplicados.`);
  }

  return map;
}

interface ImageUploadTask {
  productId: string;
  files: Array<{ originalSource: string; alt: string; contentType: string }>;
  label: string; // for logging
}

async function processImageQueue(admin: any, queue: ImageUploadTask[], concurrency = 10): Promise<Map<string, StoredImage[]>> {
  const resultMap = new Map<string, StoredImage[]>();
  if (queue.length === 0) return resultMap;
  console.log(`[Import] Processing image queue: ${queue.length} products, batch size ${concurrency}`);

  for (let i = 0; i < queue.length; i += concurrency) {
    const batch = queue.slice(i, i + concurrency);
    const promises = batch.map(async (task) => {
      try {
        const res = await graphqlWithRetry(admin,
          `#graphql
          mutation productCreateMedia($id: ID!, $media: [CreateMediaInput!]!) {
            productCreateMedia(productId: $id, media: $media) { media { id } userErrors { field message } }
          }`,
          { id: task.productId, media: task.files.map((f) => ({ originalSource: f.originalSource, alt: f.alt, mediaContentType: f.contentType })) }
        );
        const mediaIds: string[] = (res.data?.productCreateMedia?.media || []).map((m: any) => m.id).filter(Boolean);
        if (mediaIds.length > 0) {
          const stored: StoredImage[] = mediaIds.map((mediaId, idx) => ({
            mediaId,
            url: task.files[idx]?.originalSource || "",
          }));
          resultMap.set(task.productId, stored);
        }
      } catch (error: any) {
        console.error(`[Import] Images ERROR: ${task.label}:`, error?.message);
      }
    });
    await Promise.all(promises);
    if (i + concurrency < queue.length) await sleep(200);
  }
  console.log(`[Import] Image queue complete: ${queue.length} products processed`);
  return resultMap;
}

export interface StoredImage {
  mediaId: string;
  url: string;
}

function normalizeImageUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/$/, "");
  } catch {
    return url.replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}

export async function queryProductMedia(admin: any, productId: string, shopDomain?: string): Promise<StoredImage[]> {
  // A1: entradas desde bulk/webhooks pasan la tienda → contexto de refresh
  // correcto; sin tienda (o ya en contexto) se ejecuta tal cual con el admin dado.
  return withShopCtx(shopDomain, admin, async () => {
    const mediaRes = await graphqlWithRetry(admin,
      `#graphql
      query productMedia($id: ID!) {
        product(id: $id) {
          media(first: 50) {
            edges {
              node {
                id
                ... on MediaImage {
                  image {
                    url
                  }
                }
              }
            }
          }
        }
      }`,
      { id: productId }
    );
    const images: StoredImage[] = [];
    for (const edge of mediaRes.data?.product?.media?.edges || []) {
      const node = edge.node;
      if (node?.id) {
        const url = node.image?.url || "";
        images.push({ mediaId: node.id, url });
      }
    }
    return images;
  });
}

export async function incrementalImageUpdate(
  admin: any,
  shopDomain: string,
  shopifyProductId: string,
  supplierSku: string,
  csvFiles: Array<{ originalSource: string; alt: string; contentType: string }>,
  label: string,
  storedImages?: StoredImage[],
): Promise<{ changed: boolean; newImages: StoredImage[] }> {
  // A1: bulk entra aquí sin contexto de tienda → crearlo con ESTE shopDomain/admin
  // (si ya existe — ruta chunks — se reutiliza para conservar el admin refrescado)
  return withShopCtx(shopDomain, admin, () =>
    incrementalImageUpdateInner(admin, shopifyProductId, supplierSku, csvFiles, label, storedImages)
  );
}

async function incrementalImageUpdateInner(
  admin: any,
  shopifyProductId: string,
  supplierSku: string,
  csvFiles: Array<{ originalSource: string; alt: string; contentType: string }>,
  label: string,
  storedImages?: StoredImage[],
): Promise<{ changed: boolean; newImages: StoredImage[] }> {
  // 1. Query current Shopify media
  const currentMedia = await queryProductMedia(admin, shopifyProductId);
  const storedByMediaId = new Map((storedImages || []).map((s) => [s.mediaId, s.url]));

  // Pair each live media with its stored supplier URL (may be empty if prior bad write)
  const paired: StoredImage[] = currentMedia.map((m) => ({
    mediaId: m.mediaId,
    url: storedByMediaId.get(m.mediaId) || "",
  }));
  const pairedIds = new Set(paired.map((p) => p.mediaId));

  // CSV supplier URLs not yet accounted for by a live media's stored URL
  const accounted = new Set(paired.filter((p) => p.url).map((p) => normalizeImageUrl(p.url)));
  const unmatchedCsv = csvFiles.filter((f) => !accounted.has(normalizeImageUrl(f.originalSource)));

  // 2. Repair: live media with empty/missing supplier URL → pair with unmatched CSV by order
  //    (fixes prior bug where new mediaId was saved with url:"")
  const orphans = paired.filter((p) => !p.url);
  let repairCount = 0;
  for (let i = 0; i < orphans.length && i < unmatchedCsv.length; i++) {
    orphans[i].url = unmatchedCsv[i].originalSource;
    repairCount++;
    console.log(`[Import] Images ${label}: repair empty url ${orphans[i].mediaId} → ${unmatchedCsv[i].originalSource}`);
  }
  const stillToAdd = unmatchedCsv.slice(repairCount);

  // 3. Nothing to add (repairs alone may still change DB)
  if (stillToAdd.length === 0) {
    if (repairCount === 0) {
      return { changed: false, newImages: paired };
    }
    console.log(`[Import] Images ${label}: keep=${paired.length}, repair=${repairCount} (no add)`);
    return { changed: true, newImages: paired };
  }

  console.log(`[Import] Images ${label}: keep=${paired.length}, repair=${repairCount}, add=${stillToAdd.length} (never delete)`);

  // 4. Add missing images via productUpdate
  const productUpdateRes = await graphqlWithRetry(admin,
    `#graphql
    mutation productUpdate($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
      productUpdate(product: $product, media: $media) {
        product {
          media(first: 50) {
            edges {
              node {
                id
                ... on MediaImage {
                  image { url }
                }
              }
            }
          }
        }
        userErrors { field message }
      }
    }`,
    {
      product: { id: shopifyProductId },
      media: stillToAdd.map((f) => ({ originalSource: f.originalSource, mediaContentType: f.contentType || "IMAGE" })),
    },
  );

  const userErrors = productUpdateRes.data?.productUpdate?.userErrors || [];
  if (userErrors.length > 0) {
    console.error(`[Import] Images ${label}: productUpdate userErrors=${JSON.stringify(userErrors)}`);
  }

  // 5. Pair NEW media IDs (not already known) with stillToAdd by submission order.
  //    CDN urls never match supplier urls — do not use them for pairing.
  const addedIds: string[] = [];
  for (const edge of productUpdateRes.data?.productUpdate?.product?.media?.edges || []) {
    const id = edge.node?.id;
    if (id && !pairedIds.has(id)) {
      addedIds.push(id);
    }
  }
  for (let i = 0; i < addedIds.length; i++) {
    const supplierUrl = stillToAdd[i]?.originalSource || "";
    paired.push({ mediaId: addedIds[i], url: supplierUrl });
    pairedIds.add(addedIds[i]);
    console.log(`[Import] Images ${label}: pair new ${addedIds[i]} → ${supplierUrl}`);
  }
  if (addedIds.length < stillToAdd.length) {
    console.warn(`[Import] Images ${label}: expected ${stillToAdd.length} new media, got ${addedIds.length} (async processing?)`);
  }

  return { changed: true, newImages: paired };
}

async function graphqlWithRetry(adminParam: any, query: string, vars: any, maxRetries = 3): Promise<any> {
  // A1: admin del contexto de la tienda actual (incluye el admin refrescado
  // mid-import). Sin contexto → el admin que pasa el llamante (su propia tienda).
  const ctx = _importCtx.getStore();
  const admin = ctx ? ctx.adminRef.current : adminParam;
  try {
    return await rateLimitedGraphql(admin, query, vars, maxRetries, false, ctx?.shopDomain);
  } catch (e: any) {
    const msg = e?.message || "";
    const isAuth = msg.includes("Unauthorized") || msg.includes("Session not found") || e?.response?.status === 401;
    if (!isAuth || !ctx) throw e;

    const shopDomain = ctx.shopDomain;
    console.log(`[Import] Token expired mid-import for ${shopDomain}, refreshing...`);
    const now = Date.now();
    const lastRefresh = _lastRefreshAt.get(shopDomain) || 0;
    if (now - lastRefresh < MIN_REFRESH_INTERVAL_MS) {
      // N2: hubo un refresh hace <30s (otro hilo del pool) — recrear cliente
      // con la sesión ya renovada, sin repetir el OAuth
      const { admin: freshAdmin } = await shopify.unauthenticated.admin(shopDomain);
      ctx.adminRef.current = freshAdmin;
      console.log(`[Import] Token refreshed recently for ${shopDomain}, reusing...`);
      // A4: reintento del mismo request lógico → no cobra token del bucket
      return rateLimitedGraphql(ctx.adminRef.current, query, vars, maxRetries, true, ctx.shopDomain);
    }

    const newToken = await refreshAccessToken(shopDomain);
    if (!newToken) {
      throw new Error(`Token expirado para ${shopDomain} y no se pudo refrescar.`);
    }
    _lastRefreshAt.set(shopDomain, now);

    const { admin: newAdmin } = await shopify.unauthenticated.admin(shopDomain);
    ctx.adminRef.current = newAdmin;
    console.log(`[Import] Token refreshed mid-import for ${shopDomain}, retrying...`);

    // A4: reintento del mismo request lógico → no cobra token del bucket
    return rateLimitedGraphql(ctx.adminRef.current, query, vars, maxRetries, true, ctx.shopDomain);
  }
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

async function updateVariantSku(shopDomain: string, productId: string, variantId: string, sku: string): Promise<void> {
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken) {
    console.error(`[Import] SKU ${sku}: no session found for ${shopDomain}, skip REST SKU update`);
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
    throw new Error(`REST SKU update ${resp.status}: ${body}`);
  }
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

async function setStock(admin: any, inventoryItemId: string, locationId: string, targetQuantity: number, sku: string, maxRetries = 3): Promise<void> {
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
    console.error("[Import] setStock activation error:", e?.message);
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const idempotencyKey = `inv-set-${inventoryItemId}-${locationId}-${targetQuantity}-${Date.now()}`;
    try {
      const stockRes = await graphqlWithRetry(admin,
        `#graphql
        mutation inventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
          inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryAdjustmentGroup { id }
            userErrors { field message code }
          }
        }`,
        {
          input: {
            name: "available",
            reason: "correction",
          quantities: [{
            inventoryItemId,
            locationId,
            quantity: targetQuantity,
            changeFromQuantity: null,
          }],
          },
          idempotencyKey,
        }
      );

      const mutationData = stockRes.data?.inventorySetQuantities;
      if (!mutationData) {
        console.error(`[Import] Stock mutation returned null for SKU ${sku}:`, JSON.stringify(stockRes).slice(0, 500));
        continue;
      }

      const stockErrors = mutationData.userErrors || [];
      if (stockErrors.length) {
        console.error(`[Import] Stock userErrors for SKU ${sku}:`, JSON.stringify(stockErrors));
        return;
      }

      console.log(`[Import] Stock set to ${targetQuantity} for SKU ${sku}`);
      return;
    } catch (error: any) {
      const gqlErrors = error?.graphQLErrors || error?.response?.errors;
      console.error(`[Import] Stock exception SKU=${sku} invItem=${inventoryItemId} loc=${locationId} qty=${targetQuantity} (attempt ${attempt}/${maxRetries}):`, error?.message?.slice(0, 200), gqlErrors ? JSON.stringify(gqlErrors).slice(0, 500) : "");
      if (attempt < maxRetries) await sleep(1000 * attempt);
    }
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
  costChanges: number;
  titleChanges: number;
  descriptionChanges: number;
  vendorChanges: number;
  productTypeChanges: number;
  tagsChanges: number;
  imageChanges: number;
  errors: Array<{ sku: string; error: string; lineNumber?: number }>;
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
  resumeFromSku?: string;
}

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  // A1: todo el import corre dentro de un contexto de tienda → graphqlWithRetry
  // y todo el árbol async (worker pool, sleeps, streams) usan el admin de ESTA
  // tienda; el refresh de 401 actualiza solo este contexto.
  return _importCtx.run(
    { shopDomain: opts.shopDomain, adminRef: { current: opts.admin } },
    () => runImportInner(opts)
  );
}

async function runImportInner({ shopDomain, admin, filterType, filterSkus, filterCategories, signal, triggerType, configId, queueItemId, resumeFromSku }: ImportOptions): Promise<ImportResult> {
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

  // M2: sin precarga del catálogo — el lookup por EAN/SKU se hace por chunk
  // (lookupBarcodeMatchesForChunk) justo antes de procesar cada lote de filas.

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
    costChanges: 0,
    titleChanges: 0,
    descriptionChanges: 0,
    vendorChanges: 0,
    productTypeChanges: 0,
    tagsChanges: 0,
    imageChanges: 0,
    errors: [],
    lastSku: "",
  };

  // M4': Set en vez de array — el lookup final de SKUs ausentes era O(n×m)
  // (Array.includes por cada mapping) → con 500k filas serían billones de ops.
  const csvSkus = new Set<string>();
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

  // Pre-count: total de filas elegibles fijo para la barra desde el inicio
  // (bloque antes del stream). cancelled fuera del try para que el catch de
  // abort también lo vea y escriba cancelled_manually.
  let preCount: number | null = null;
  let cancelled = false;

  try {
    const seenSkus = new Set<string>();
    let skipping = !!resumeFromSku;
    const resumeSkuLower = resumeFromSku?.toLowerCase();

    let checkCounter = 0;
    const processedInventoryItems = new Set<string>();
    const imageQueue: ImageUploadTask[] = [];
    // T2b: creates cuya productSet no devolvió media nodes → resolver al final
    const mediaToResolve: Array<{ productId: string; csvFiles: string[] }> = [];
    // M3: worker pool por fila (patrón bulk-import:2206) — la latencia por fila
    // (~2s GraphQL) se solapa en N workers. Contadores/result son incrementos
    // síncronos (event loop único) → seguro; el bucket por coste (M1) regula la
    // tasa real hacia Shopify. Clamp 1-8, default 4 (env CHUNK_ROW_CONCURRENCY).
    const rowConcurrency = Math.max(1, Math.min(8, Number(process.env.CHUNK_ROW_CONCURRENCY) || 4));

    // M4': el lote se procesa AL LLENARSE mientras se hace stream del fichero
    // (antes: TODAS las filas se acumulaban en el array `chunks` en RAM antes de
    // la primera mutación → con ficheros grandes, cientos de MB en memoria).
    // Memoria de filas = O(chunk de chunkSize). El fichero viene del bucket (URL
    // presignada) y se lee en streaming — esa ruta no se toca.
    const processChunk = async (chunk: Array<{ headers: string[]; row: any; lineNumber: number }>) => {
      // M2: lookup de las claves (SKU+EAN) de ESTE chunk — O(chunk de 50 filas),
      // sin precarga del catálogo (memoria y tiempo de arranque constantes)
      const chunkSkus: string[] = [];
      const chunkEans: string[] = [];
      for (const item of chunk) {
        const r = item.row;
        chunkSkus.push((getField(r, columnMaps, "sku") || r["SKU"] || r["sku"] || "").trim());
        chunkEans.push((getField(r, columnMaps, "ean") || r["ean"] || r["EAN"] || "").trim());
      }
      const barcodeMap = await lookupBarcodeMatchesForChunk(admin, chunkSkus, chunkEans);
      console.log(`[Import] Chunk lookup: ${chunk.length} filas → ${barcodeMap.size} coincidencias`);

      // M3: watermark por CHUNK — lastSku = última fila con SKU del chunk SOLO
      // cuando el chunk completo drena (no al empezar cada fila). Crash a mitad
      // de chunk → el resume repite el chunk entero (idempotente) y nunca salta
      // filas sin procesar (antes, con pool, un lastSku "en vuelo" podría hacerlo).
      let chunkWatermarkSku = "";
      for (const item of chunk) {
        const s = (getField(item.row, columnMaps, "sku") || item.row["SKU"] || item.row["sku"] || "").trim();
        if (s) chunkWatermarkSku = s;
      }

      let nextIdx = 0;
      const worker = async () => {
        while (true) {
          if (cancelled) return;
          const idx = nextIdx++;
          if (idx >= chunk.length) return;
          const item = chunk[idx];

          checkCounter++;
          // Check abort signal immediately, or check config every 5 products for cron
          if (signal?.aborted) {
            console.log(`[Import] Importación cancelada por usuario (check #${checkCounter})`);
            cancelled = true;
            return;
          }
          if (triggerType !== "manual" && checkCounter % 5 === 0) {
            const freshConfig = await prisma.importConfig.findUnique({ where: { id: config.id }, select: { isActive: true } });
            if (!freshConfig?.isActive) {
              console.log(`[Import] Importación cancelada (config desactivada, check #${checkCounter})`);
              cancelled = true;
              return;
            }
          }

          const { row, lineNumber } = item;
          const sku = (getField(row, columnMaps, "sku") || row["SKU"] || row["sku"] || "").trim();

          if (!sku) {
            result.errors.push({ sku: "UNKNOWN", error: "systemError.empty_sku", lineNumber });
            continue;
          }

          csvSkus.add(sku);

          try {
            const excludedFields = getExcludedFields(sku, fieldRules, getField(row, columnMaps, "ean") || row["ean"] || row["EAN"] || "");
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
              sourceKey,
              imageQueue,
              mediaToResolve,
              barcodeMap,
            });
          } catch (error: any) {
            const errorMsg = error?.message || "systemError.unknown_error";
            let retried = false;

            for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
              await new Promise((r) => setTimeout(r, 2000));
              try {
                const excludedFields = getExcludedFields(sku, fieldRules, getField(row, columnMaps, "ean") || row["ean"] || row["EAN"] || "");
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
                  sourceKey,
                  imageQueue,
                  mediaToResolve,
                  barcodeMap,
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
          // T2a: sin sleep(500)/fila — el bucket por coste (M1, Standard=100pts/s)
          // regula la tasa real; los workers solo solapan latencia.

          // Update progress every 10 products
          if (checkCounter % 10 === 0) {
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
      };
      await Promise.all(Array.from({ length: Math.min(rowConcurrency, chunk.length) }, () => worker()));
      if (!cancelled && chunkWatermarkSku) result.lastSku = chunkWatermarkSku;
    };

    // Pre-count: pasada de solo lectura O(1) que replica los checks del stream
    // principal (resume/filtro/dedup/exclusión) y fija totalProducts ANTES del
    // primer producto → la barra muestra el total real desde el inicio (como
    // antes de M4', sin acumular el fichero en RAM). Si falla, se sigue con el
    // comportamiento actual (total creciente) — el import no se rompe por esto.
    try {
      const t0 = Date.now();
      const pcSeen = new Set<string>();
      let pcSkipping = !!resumeFromSku;
      let pcRows = 0;
      let n = 0;
      for await (const item of streamFile(await resolveFileUrl(getEffectiveUrl(config)), config.csvDelimiter, 3, signal)) {
        const { row } = item;
        if (++pcRows % 1000 === 0 && signal?.aborted) {
          cancelled = true;
          break;
        }
        const rowSku = (getField(row, columnMaps, "sku") || row["sku"] || "").trim().toLowerCase();

        if (pcSkipping) {
          if (rowSku === resumeSkuLower) pcSkipping = false;
          else continue;
        }

        const rowCat = (getField(row, columnMaps, "category") || row["category"] || "").trim().toLowerCase();
        if (hasAnyFilter) {
          const skuMatch = skuSet?.has(rowSku) ?? false;
          const catMatch = catSet?.has(rowCat) ?? false;
          if (!skuMatch && !catMatch) continue;
        }

        if (pcSeen.has(rowSku)) continue;
        pcSeen.add(rowSku);

        const exclusion = isExcluded(row, columnMaps, config, getField, { sku: getField(row, columnMaps, "sku") || row["sku"] || "", ean: getField(row, columnMaps, "ean") || row["ean"] || "" });
        if (exclusion.excluded) continue;

        n++;
      }
      if (!cancelled) {
        preCount = n;
        result.totalProducts = n;
        await prisma.importLog.update({ where: { id: log.id }, data: { totalProducts: n } }).catch(() => {});
        console.log(`[Import] Pre-count: ${n} filas elegibles en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    } catch (e: any) {
      if (signal?.aborted) {
        cancelled = true;
        console.log(`[Import] Cancelada durante el pre-count`);
      } else {
        console.warn(`[Import] Pre-count falló (${e?.message || e}) — el total crecerá durante la importación`);
        preCount = null;
      }
    }
    if (signal?.aborted) cancelled = true;

    let currentChunk: Array<{ headers: string[]; row: any; lineNumber: number }> = [];
    for await (const item of streamFile(await resolveFileUrl(getEffectiveUrl(config)), config.csvDelimiter, 3, signal)) {
      const { row } = item;
      const rowSku = (getField(row, columnMaps, "sku") || row["sku"] || "").trim().toLowerCase();

      // "Ausente = no está en el FICHERO": registrar el SKU ANTES de resume/
      // filtro/dedup/exclusion — el lookup de stock 0 (csvSkus) debe ver todas
      // las filas leídas, no solo las procesadas (con filtro estrecho se zeraba
      // el stock de las mappings fuera del filtro). Expresión idéntica a la de
      // processProduct para casar con mapping.supplierSku.
      const skuRaw = (getField(row, columnMaps, "sku") || row["SKU"] || row["sku"] || "").trim();
      if (skuRaw) csvSkus.add(skuRaw);

      // Checkpoint resume: skip until we find the last processed SKU
      if (skipping) {
        if (rowSku === resumeSkuLower) {
          skipping = false;
          console.log(`[Import] Resume: encontrado SKU ${resumeFromSku}, procesando desde aquí`);
        } else {
          continue;
        }
      }

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
        excludedCount++;
        continue;
      }

      if (preCount == null) result.totalProducts++;
      currentChunk.push(item);

      if (currentChunk.length >= config.chunkSize) {
        await processChunk(currentChunk);
        currentChunk = [];
        if (cancelled) break;
      }
    }
    if (!cancelled && currentChunk.length > 0) {
      await processChunk(currentChunk);
    }

    if (!cancelled) {
    const existingMappings = await prisma.productMapping.findMany({
      where: { shopDomain, configId: config.id, lastImportSource: sourceKey },
    });

    for (const mapping of existingMappings) {
      if (!csvSkus.has(mapping.supplierSku)) {
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

    // T2b fallback: media de creates que la productSet no devolvió → una query
    // por producto al final del bucle (mucho más tarde que el viejo sleep de 2s;
    // el bucket por coste M1 limita la ráfaga). Si sigue vacío → placeholders,
    // igual que el comportamiento anterior.
    if (mediaToResolve.length > 0) {
      console.log(`[Import] Media fallback post-pasada: ${mediaToResolve.length} productos`);
      for (const item of mediaToResolve) {
        try {
          const media = await queryProductMedia(admin, item.productId);
          if (media.length > 0) {
            const stored: StoredImage[] = media.map((m, i) => ({
              mediaId: m.mediaId,
              url: item.csvFiles[i] || m.url,
            }));
            await prisma.productMapping.updateMany({
              where: { shopDomain, shopifyProductId: item.productId },
              data: { shopifyImages: JSON.stringify(stored) },
            });
          }
        } catch {}
      }
    }

    // Process all deferred image uploads in parallel batches
    if (imageQueue.length > 0) {
      const imageResults = await processImageQueue(admin, imageQueue);
      // Save mediaIds from processImageQueue results to DB mappings
      for (const [productId, stored] of imageResults) {
        try {
          const mapping = await prisma.productMapping.findFirst({
            where: { shopDomain, shopifyProductId: productId },
          });
          if (mapping) {
            await prisma.productMapping.update({
              where: { id: mapping.id },
              data: { shopifyImages: JSON.stringify(stored) },
            });
          }
        } catch {}
      }
    }

    await prisma.importLog.update({
      where: { id: log.id },
      data: {
        status: cancelled ? "failed" : result.errors.length > 0 ? "completed_with_errors" : "completed",
        totalProducts: result.totalProducts,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        priceChanges: result.priceChanges,
        stockChanges: result.stockChanges,
        costChanges: result.costChanges,
        titleChanges: result.titleChanges,
        descriptionChanges: result.descriptionChanges,
        vendorChanges: result.vendorChanges,
        productTypeChanges: result.productTypeChanges,
        tagsChanges: result.tagsChanges,
        imageChanges: result.imageChanges,
        excludedCount: excludedCount + result.excluded,
        errors: cancelled
          ? JSON.stringify([{ sku: "SYSTEM", error: "systemError.cancelled_manually" }])
          : result.errors.length > 0 ? JSON.stringify(result.errors) : null,
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
        errors: cancelled
          ? JSON.stringify([{ sku: "SYSTEM", error: "systemError.cancelled_manually" }])
          : JSON.stringify([{ error: error?.message || "systemError.general_error" }]),
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
  sourceKey: string;
  imageQueue: ImageUploadTask[];
  mediaToResolve: Array<{ productId: string; csvFiles: string[] }>;
  barcodeMap: Map<string, BarcodeMatch>;
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
  sourceKey,
  imageQueue,
  mediaToResolve,
  barcodeMap,
}: ProcessProductOptions): Promise<void> {
  let existing = await prisma.productMapping.findUnique({
    where: { shopDomain_supplierSku: { shopDomain, supplierSku: sku } },
  });

  const costPrice = parseFloat((getField(row, columnMaps, "price") || "0").replace(",", "."));
  const category = getField(row, columnMaps, "category");
  const newQty = Math.max(0, parseInt((getField(row, columnMaps, "quantity") || row["quantity"] || "0").replace(",", ".")));

  // === INTER-SUPPLIER CHECK: existing mapping may belong to another supplier ===
  const shopSettings0 = await prisma.shopSettings.findUnique({ where: { shopDomain } });
  const dupPolicy0 = shopSettings0?.duplicatePolicy || "skip_existing";
  if (existing && existing.configId !== config.id && (dupPolicy0 === "skip_existing" || dupPolicy0 === "priority")) {
    const otherConfig = await prisma.importConfig.findUnique({ where: { id: existing.configId } });
    const otherSupplierName = otherConfig?.name || "desconocido";
    if (dupPolicy0 === "priority") {
      // Execute replace (overwrite or update based on matchMode)
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

      const matchMode0 = shopSettings0?.matchMode || "overwrite";

      // Build productUpdate patch based on matchMode + updateOpts
      try {
        const productPatch: any = { id: existing.shopifyProductId };
        if (matchMode0 === "overwrite") {
          productPatch.title = productInput2.title;
          productPatch.descriptionHtml = productInput2.descriptionHtml;
          productPatch.productType = productInput2.productType;
          productPatch.vendor = productInput2.vendor;
          productPatch.tags = productInput2.tags;
          productPatch.metafields = productInput2.metafields;
          productPatch.seo = productInput2.seo;
        } else {
          // update mode: only fields selected in updateOpts
          if (updateOpts.has("name")) productPatch.title = productInput2.title;
          if (updateOpts.has("description")) {
            productPatch.descriptionHtml = productInput2.descriptionHtml;
            productPatch.seo = productInput2.seo;
          }
          if (updateOpts.has("vendor")) productPatch.vendor = productInput2.vendor;
          if (updateOpts.has("productType")) productPatch.productType = productInput2.productType;
          if (updateOpts.has("tags")) productPatch.tags = productInput2.tags;
          if (updateOpts.has("metafields")) productPatch.metafields = productInput2.metafields;
        }
        if (Object.keys(productPatch).length > 1) {
          const updateRes = await graphqlWithRetry(admin,
            `#graphql
            mutation productUpdate($product: ProductUpdateInput!) {
              productUpdate(product: $product) { product { id } userErrors { field message } }
            }`,
            { product: productPatch }
          );
          if (updateRes.data?.productUpdate?.userErrors?.length) {
            const updateErrors = updateRes.data.productUpdate.userErrors;
            const notFound = updateErrors.some((e: any) =>
              e.message?.includes("not find") || e.message?.includes("NOT_FOUND") || e.message?.includes("was not found")
            );
            if (notFound) {
              return;
            }
            console.error(`[Import] Priority replace: productUpdate errors:`, JSON.stringify(updateErrors));
          }
        }
      } catch (e: any) {
        console.error(`[Import] Priority replace (inter): productUpdate failed for ${existing.shopifyProductId}:`, e?.message);
      }

      // Update variant: price + compareAt + barcode (only if price selected)
      let variantId2: string | undefined;
      let invItemId2: string | undefined;
      const rowEanForReplace = getField(row, columnMaps, "ean") || row["ean"] || "";
      try {
        const variantRes2 = await graphqlWithRetry(admin,
          `#graphql
          query { product(id: "${existing.shopifyProductId}") {
            variants(first: 1) { edges { node { id inventoryItem { id } } } }
          }}`,
          {}
        );
        variantId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.id;
        invItemId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.inventoryItem?.id;
      } catch (e: any) {
        console.error(`[Import] Priority replace (inter): variants query failed for ${existing.shopifyProductId}:`, e?.message);
      }
      if (variantId2 && updateOpts.has("price")) {
        try {
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
        } catch (e: any) {
          console.error(`[Import] Priority replace (inter): variantBulkUpdate failed for ${existing.shopifyProductId}:`, e?.message);
        }
        if (sku && variantId2 && matchMode0 === "overwrite") {
          try {
            await updateVariantSku(shopDomain, existing.shopifyProductId, variantId2, sku);
            } catch (e: any) {
              console.error(`[Import] Priority replace: error updating SKU:`, e?.message);
            }
        }
      }

      // Update stock (only if stock selected)
      if (updateOpts.has("stock") && invItemId2 && locationId) {
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

      // Update images — incremental (only add, never delete)
      let newShopifyImages: string | null = null;
      if (updateOpts.has("images") && productInput2.files && productInput2.files.length > 0) {
        try {
          const storedImgs: StoredImage[] = existing.shopifyImages ? JSON.parse(existing.shopifyImages) : [];
          const imgResult = await incrementalImageUpdate(
            admin, shopDomain, existing.shopifyProductId, sku,
            productInput2.files.map((f: any) => ({ originalSource: f.originalSource, alt: f.alt, contentType: f.contentType || "IMAGE" })),
            `SKU=${sku} (priority replace inter-supplier)`,
            storedImgs,
          );
          if (imgResult.changed) {
            result.imageChanges++;
            newShopifyImages = JSON.stringify(imgResult.newImages);
          }
        } catch (error: any) {
          console.error(`[Import] Priority replace inter-supplier: error updating images:`, error?.message);
        }
      }
      const newMapping2 = await prisma.productMapping.upsert({
        where: { shopDomain_supplierSku: { shopDomain, supplierSku: sku } },
        create: {
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
          lastTitle: productInput2.title ?? null,
          lastDescription: productInput2.descriptionHtml ?? null,
          lastVendor: productInput2.vendor ?? null,
          lastProductType: productInput2.productType ?? null,
          lastTags: productInput2.tags?.length ? normalizeTags(productInput2.tags) : null,
          lastImportSource: sourceKey,
          ...(newShopifyImages ? { shopifyImages: newShopifyImages } : {}),
        },
        update: {
          configId: config.id,
          ean: rowEanForReplace || null,
          shopifyProductId: existing.shopifyProductId,
          shopifyVariantId: variantId2 || null,
          shopifyInventoryItemId: invItemId2 || null,
          lastPrice: prices2.regularPrice,
          lastComparePrice: prices2.compareAtPrice,
          lastQuantity: newQty,
          lastCost: costPrice > 0 ? costPrice : null,
          lastTitle: productInput2.title ?? undefined,
          lastDescription: productInput2.descriptionHtml ?? undefined,
          lastVendor: productInput2.vendor ?? undefined,
          lastProductType: productInput2.productType ?? undefined,
          lastTags: productInput2.tags?.length ? normalizeTags(productInput2.tags) : undefined,
          lastImportSource: sourceKey,
          ...(newShopifyImages ? { shopifyImages: newShopifyImages } : {}),
        },
      });
      existing = newMapping2;
      // Auto-resolve duplicate logs for this EAN after priority replace
      try {
        if (rowEanForReplace) {
          await prisma.duplicateLog.deleteMany({
            where: { shopDomain, ean: rowEanForReplace },
          });
        }
      } catch {}
      result.updated++;
      return;
    } else {
      // skip_existing: skip (different supplier already owns this product)
      result.excluded++;
      return;
    }
  }

  // === DUPLICATE CHECK: skip_existing and priority (EAN-based via checkDuplicate) ===
  {
    const rowEan = getField(row, columnMaps, "ean") || row["ean"] || "";
    const shopSettings = await prisma.shopSettings.findUnique({ where: { shopDomain } });
    const dupPolicy = shopSettings?.duplicatePolicy || "skip_existing";
    if (rowEan && (dupPolicy === "skip_existing" || dupPolicy === "priority")) {
      const dupCheck = await checkDuplicate(shopDomain, config.id, rowEan, sku);
      if (dupCheck.shouldSkip) {
        result.excluded++;
        return;
      }
      if (dupCheck.shouldReplace && dupCheck.existingMappingId && dupCheck.existingShopifyProductId) {
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

        const matchMode2 = shopSettings?.matchMode || "overwrite";

        // Build productUpdate patch based on matchMode + updateOpts
        try {
          const productPatch: any = { id: dupCheck.existingShopifyProductId };
          if (matchMode2 === "overwrite") {
            productPatch.title = productInput2.title;
            productPatch.descriptionHtml = productInput2.descriptionHtml;
            productPatch.productType = productInput2.productType;
            productPatch.vendor = productInput2.vendor;
            productPatch.tags = productInput2.tags;
            productPatch.metafields = productInput2.metafields;
            productPatch.seo = productInput2.seo;
          } else {
            // update mode: only fields selected in updateOpts
            if (updateOpts.has("name")) productPatch.title = productInput2.title;
            if (updateOpts.has("description")) {
              productPatch.descriptionHtml = productInput2.descriptionHtml;
              productPatch.seo = productInput2.seo;
            }
            if (updateOpts.has("vendor")) productPatch.vendor = productInput2.vendor;
            if (updateOpts.has("productType")) productPatch.productType = productInput2.productType;
            if (updateOpts.has("tags")) productPatch.tags = productInput2.tags;
            if (updateOpts.has("metafields")) productPatch.metafields = productInput2.metafields;
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
            if (updateErrors.length > 0) {
              console.error(`[Import] SKU ${sku}: productUpdate errors:`, JSON.stringify(updateErrors));
            }
            if (updateErrors.length) {
              const notFound = updateErrors.some((e: any) =>
                e.message?.includes("not find") || e.message?.includes("NOT_FOUND") || e.message?.includes("was not found")
              );
              if (notFound) {
                return;
              }
              console.error(`[Import] Priority replace: productUpdate errors:`, JSON.stringify(updateErrors));
            } else {
              console.log(`[Import] Priority replace: productUpdate OK for ${dupCheck.existingShopifyProductId}`);
            }
          }
        } catch (e: any) {
          console.error(`[Import] Priority replace (EAN): productUpdate failed for ${dupCheck.existingShopifyProductId}:`, e?.message);
        }

        // Update variant: SKU + price + compareAt + barcode
        let variantId2: string | undefined;
        let invItemId2: string | undefined;
        try {
          const variantRes2 = await graphqlWithRetry(admin,
            `#graphql
            query { product(id: "${dupCheck.existingShopifyProductId}") {
              variants(first: 1) { edges { node { id inventoryItem { id } } } }
            }}`,
            {}
          );
          variantId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.id;
          invItemId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.inventoryItem?.id;
        } catch (e: any) {
          console.error(`[Import] Priority replace (EAN): variants query failed for ${dupCheck.existingShopifyProductId}:`, e?.message);
        }
        if (variantId2 && updateOpts.has("price")) {
          try {
            const variantPatch: any = {
              id: variantId2,
              price: prices2.regularPrice.toString(),
              compareAtPrice: (prices2.compareAtPrice ?? 0) > 0 ? prices2.compareAtPrice!.toString() : null,
            };
            if (rowEan) variantPatch.barcode = rowEan;
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
            }
            if (sku && matchMode2 === "overwrite") {
              try {
                await updateVariantSku(shopDomain, dupCheck.existingShopifyProductId, variantId2, sku);
              } catch (e: any) {
                console.error(`[Import] Priority replace: error updating SKU:`, e?.message);
              }
            }
          } catch (e: any) {
            console.error(`[Import] Priority replace: variant update EXCEPTION:`, e?.message || String(e));
          }
        } else {
          if (!variantId2) console.error(`[Import] Priority replace: no variantId found for product ${dupCheck.existingShopifyProductId}`);
        }


        // Update stock at configured location (only if stock selected)
        if (updateOpts.has("stock") && invItemId2 && locationId) {
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

        // Update images — incremental (only add, never delete)
        let newShopifyImages2: string | null = null;
        if (updateOpts.has("images") && productInput2.files && productInput2.files.length > 0) {
          try {
            const dupMapping = await prisma.productMapping.findFirst({
              where: { shopDomain, shopifyProductId: dupCheck.existingShopifyProductId },
              select: { shopifyImages: true },
            }).catch(() => null);
            const storedImgs2: StoredImage[] = dupMapping?.shopifyImages ? JSON.parse(dupMapping.shopifyImages) : [];
            const imgResult = await incrementalImageUpdate(
              admin, shopDomain, dupCheck.existingShopifyProductId, sku,
              productInput2.files.map((f: any) => ({ originalSource: f.originalSource, alt: f.alt, contentType: f.contentType || "IMAGE" })),
              `SKU=${sku} (priority replace EAN dup)`,
              storedImgs2,
            );
            if (imgResult.changed) {
              result.imageChanges++;
              newShopifyImages2 = JSON.stringify(imgResult.newImages);
            }
          } catch (error: any) {
            console.error(`[Import] Priority replace EAN dup: error updating images:`, error?.message);
          }
        }

        // Update mapping: delete old (other supplier) for overwrite, or just reassign for update
        if (matchMode2 === "overwrite") {
          try {
            await prisma.productMapping.delete({ where: { id: dupCheck.existingMappingId } });
          } catch (e: any) {
            console.error(`[Import] Priority replace: error deleting old mapping:`, e?.message);
          }
          // Delete any existing mapping for this SKU from current supplier (unique constraint)
          if (existing && existing.configId === config.id) {
            try {
              await prisma.productMapping.delete({ where: { id: existing.id } });
            } catch (e: any) {
              console.error(`[Import] Priority replace: error deleting existing mapping:`, e?.message);
            }
          }
        }
        try {
          const newMapping2 = await prisma.productMapping.upsert({
            where: { shopDomain_supplierSku: { shopDomain, supplierSku: sku } },
            create: {
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
              lastImportSource: sourceKey,
              ...(newShopifyImages2 ? { shopifyImages: newShopifyImages2 } : {}),
            },
            update: {
              configId: config.id,
              ean: rowEan || null,
              shopifyProductId: dupCheck.existingShopifyProductId,
              shopifyVariantId: variantId2 || null,
              shopifyInventoryItemId: invItemId2 || null,
              lastPrice: prices2.regularPrice,
              lastComparePrice: prices2.compareAtPrice,
              lastQuantity: newQty,
              lastCost: costPrice > 0 ? costPrice : null,
              lastImportSource: sourceKey,
              ...(newShopifyImages2 ? { shopifyImages: newShopifyImages2 } : {}),
            },
          });
          existing = newMapping2;
        } catch (e: any) {
          console.error(`[Import] Priority replace: error upserting new mapping:`, e?.message);
        }
        // Auto-resolve duplicate logs for this EAN after priority replace
        try {
          if (rowEan) {
            await prisma.duplicateLog.deleteMany({
              where: { shopDomain, ean: rowEan },
            });
          }
        } catch {}
        result.updated++;
        return;
      }

      // External product detection: checkDuplicate only queries ProductMapping.
      // If no match found, check barcodeMap for external products (same EAN, no mapping).
      if (!dupCheck.shouldSkip && !dupCheck.shouldReplace) {
        let foundBarcode: BarcodeMatch | null = null;
        if (rowEan) foundBarcode = barcodeMap.get(rowEan) || null;
        if (!foundBarcode && sku) foundBarcode = barcodeMap.get(sku) || null;

        if (foundBarcode) {
          const foundSku = (foundBarcode.sku || "").trim();
          if (foundSku && foundSku !== sku) {
            // External product with different SKU
            if (dupPolicy === "skip_existing") {
              await logExternalDuplicate(shopDomain, rowEan, foundBarcode.productId, sku, config.id, config.name || "Proveedor", foundBarcode.sku);
              result.excluded++;
              return;
            }
            if (dupPolicy === "priority") {
              // Check applyToExternal setting
              if (shopSettings?.applyToExternal === false) {
                await logExternalDuplicate(shopDomain, rowEan, foundBarcode.productId, sku, config.id, config.name || "Proveedor", foundBarcode.sku);
                result.excluded++;
                return;
              }

              // Adopt: upsert mapping, then fall through to SINGLE UPDATE PATH
              const prices2 = await calculatePrices(shopDomain, sku, category, costPrice, config.id);
              let variantId2: string | undefined;
              let invItemId2: string | undefined;
              try {
                const variantRes2 = await graphqlWithRetry(admin,
                  `#graphql
                  query { product(id: "${foundBarcode.productId}") {
                    variants(first: 1) { edges { node { id inventoryItem { id } } } }
                  }}`,
                  {}
                );
                variantId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.id;
                invItemId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.inventoryItem?.id;
              } catch (e: any) {
                console.error(`[Import] External: variants query failed for ${foundBarcode.productId}:`, e?.message);
              }
              existing = await prisma.productMapping.upsert({
                where: { shopDomain_supplierSku: { shopDomain, supplierSku: sku } },
                create: {
                  shopDomain, configId: config.id, supplierSku: sku, ean: rowEan || null,
                  shopifyProductId: foundBarcode.productId, shopifyVariantId: variantId2 || null,
                  shopifyInventoryItemId: invItemId2 || null,
                  lastPrice: prices2.regularPrice, lastComparePrice: prices2.compareAtPrice,
                  lastQuantity: null, lastCost: costPrice > 0 ? costPrice : null, lastImportSource: sourceKey,
                },
                update: {
                  shopifyProductId: foundBarcode.productId, shopifyVariantId: variantId2 || null,
                  shopifyInventoryItemId: invItemId2 || null, lastImportSource: sourceKey,
                },
              });
              console.log(`[Import] External: adopted ${foundBarcode.productId} (same EAN, different SKU) — falling through to UPDATE path`);
              // NO return — fall through to SINGLE UPDATE PATH (line 1717+)
            }
          }
        }
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
  let shopifyLiveTags: string[] | null = null;
  if (existing) {
    try {
      const checkJson = await graphqlWithRetry(admin,
        `#graphql
        query productById($id: ID!) {
          product(id: $id) { id title tags variants(first: 1) { edges { node { id inventoryItem { id } } } } }
        }`,
        { id: existing.shopifyProductId }
      );
      if (checkJson.data?.product?.id) {
        // Product exists — keep mapping
        shopifyLiveTags = checkJson.data.product.tags ?? null;
        // Backfill inventoryItemId if missing in DB
        if (!existing.shopifyInventoryItemId) {
          const invItemId = checkJson.data.product?.variants?.edges?.[0]?.node?.inventoryItem?.id;
          if (invItemId) {
            try {
              await prisma.productMapping.update({
                where: { id: existing.id },
                data: {
                  shopifyInventoryItemId: invItemId,
                  lastQuantity: null,
                  lastCost: null,
                },
              });
              existing = { ...existing, shopifyInventoryItemId: invItemId, lastQuantity: null, lastCost: null } as any;
              console.log(`[Import] SKU ${sku}: backfilled shopifyInventoryItemId=${invItemId} + reset lastQty/lastCost for re-sync`);
            } catch (e: any) {
              console.log(`[Import] SKU ${sku}: backfill DB update FAILED: ${e?.message}`);
            }
          } else {
            console.log(`[Import] SKU ${sku}: backfill FAILED — invItemId is null/undefined. product.variants edges count=${checkJson.data.product?.variants?.edges?.length}`);
          }
        }
      } else if (checkJson.errors?.length) {
        // Don't delete mapping on GraphQL errors
        return;
      } else {
        // Product not found by ID — try SKU search before deleting
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
          await prisma.productMapping.update({
            where: { id: existing.id },
            data: {
              shopifyProductId: found.product.id,
              shopifyVariantId: found.id,
              shopifyInventoryItemId: found.inventoryItem?.id ?? existing.shopifyInventoryItemId,
            },
          });
          existing = await prisma.productMapping.findUnique({ where: { id: existing.id } });
          // Fetch live tags for the new product ID
          try {
            const recheck = await graphqlWithRetry(admin,
              `#graphql query productById($id: ID!) { product(id: $id) { tags } }`,
              { id: found.product.id }
            );
            shopifyLiveTags = recheck.data?.product?.tags ?? null;
          } catch { /* ignore */ }
        } else {
          await prisma.productMapping.delete({ where: { id: existing.id } });
          existing = null;
        }
      }
    } catch (error: any) {
      return;
    }
  }

  // If no existing mapping, try to find product in Shopify via barcodeMap (pre-loaded)
  let priorityReplaceTarget: { mappingId: string; shopifyProductId: string; supplierName: string; configId: string } | null = null;
  if (!existing) {
    if (config.skipZeroStockCreate && newQty <= 0) {
      result.excluded++;
      return;
    }

    const rowEan = getField(row, columnMaps, "ean") || row["ean"] || "";
    const shopSettings = await prisma.shopSettings.findUnique({ where: { shopDomain } });
    const dupPolicy2 = shopSettings?.duplicatePolicy || "skip_existing";

    // Fast lookup from pre-loaded barcode map
    let foundBarcode: BarcodeMatch | null = null;
    if (rowEan) foundBarcode = barcodeMap.get(rowEan) || null;
    if (!foundBarcode && sku) foundBarcode = barcodeMap.get(sku) || null;

    if (foundBarcode) {
      console.log(`[Import] External product detected via barcodeMap: EAN=${rowEan} SKU=${sku} → found SKU=${foundBarcode.sku} product=${foundBarcode.productId}`);
      const foundSku = (foundBarcode.sku || "").trim();

      if (foundSku && foundSku !== sku) {
        // Different SKU — check if it's intra, inter, or external (no mapping)
        const foundMapping = await prisma.productMapping.findFirst({
          where: { shopDomain, shopifyProductId: foundBarcode.productId },
        });
        if (foundMapping && foundMapping.configId !== config.id) {
          // Inter-supplier: different supplier owns this product
          if (dupPolicy2 === "priority") {
            const suppName2 = (await prisma.importConfig.findUnique({ where: { id: foundMapping.configId } }))?.name || "desconocido";
            priorityReplaceTarget = { mappingId: foundMapping.id, shopifyProductId: foundMapping.shopifyProductId, supplierName: suppName2, configId: foundMapping.configId };
          } else if (dupPolicy2 === "create_both") {
            // Inter + create_both: create new (fall through to create)
          } else {
            // Inter + skip_existing: skip
            await logExternalDuplicate(shopDomain, rowEan, foundBarcode.productId, sku, config.id, config.name || "Proveedor");
            result.excluded++;
            return;
          }
        } else {
          // External product with no mapping (or same supplier) — handle by dupPolicy
          if (dupPolicy2 === "priority") {
            priorityReplaceTarget = { mappingId: "", shopifyProductId: foundBarcode.productId, supplierName: "EXTERNAL", configId: "" };
          } else if (dupPolicy2 === "create_both") {
            // create_both: fall through to create new product
          } else {
            await logExternalDuplicate(shopDomain, rowEan, foundBarcode.productId, sku, config.id, config.name || "Proveedor");
            result.excluded++;
            return;
          }
        }
      } else {
        // Same SKU found in Shopify → adopt
        let adoptInventoryItemId: string | null = null;
        try {
          const adoptRes = await graphqlWithRetry(admin,
            `#graphql
            query productVariant($id: ID!) {
              product(id: $id) {
                variants(first: 1) {
                  edges {
                    node {
                      id
                      inventoryItem { id }
                    }
                  }
                }
              }
            }`,
            { id: foundBarcode.productId }
          );
          adoptInventoryItemId = adoptRes.data?.product?.variants?.edges?.[0]?.node?.inventoryItem?.id || null;
        } catch {}

        const mapping = await prisma.productMapping.upsert({
          where: { shopDomain_supplierSku: { shopDomain, supplierSku: sku } },
          create: {
            shopDomain, configId: config.id, supplierSku: sku, ean: rowEan || null,
            shopifyProductId: foundBarcode.productId, shopifyVariantId: foundBarcode.variantId, shopifyInventoryItemId: adoptInventoryItemId,
            lastPrice: prices.regularPrice, lastComparePrice: prices.compareAtPrice,
            lastQuantity: newQty, lastCost: costPrice > 0 ? costPrice : null,
            lastTitle: productInput.title ?? null, lastDescription: productInput.descriptionHtml ?? null,
            lastVendor: productInput.vendor ?? null, lastProductType: productInput.productType ?? null,
          lastTags: productInput.tags?.length ? normalizeTags(productInput.tags) : null,
          lastImportSource: sourceKey,
        },
          update: {
            shopifyProductId: foundBarcode.productId, shopifyVariantId: foundBarcode.variantId,
            shopifyInventoryItemId: adoptInventoryItemId || undefined,
            lastTitle: productInput.title ?? undefined, lastDescription: productInput.descriptionHtml ?? undefined,
            lastVendor: productInput.vendor ?? undefined, lastProductType: productInput.productType ?? undefined,
            lastTags: productInput.tags?.length ? normalizeTags(productInput.tags) : undefined,
            lastImportSource: sourceKey,
          },
        });
        existing = mapping;
      }
    }
  }

  // === PRIORITY REPLACE: overwrite or update based on matchMode ===
  if (priorityReplaceTarget) {
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

    const shopSettingsPR = await prisma.shopSettings.findUnique({ where: { shopDomain } });
    const matchModePR = shopSettingsPR?.matchMode || "overwrite";

    // Build productUpdate patch based on matchMode + updateOpts
    try {
      const productPatch: any = { id: priorityReplaceTarget.shopifyProductId };
      if (matchModePR === "overwrite") {
        productPatch.title = productInput2.title;
        productPatch.descriptionHtml = productInput2.descriptionHtml;
        productPatch.productType = productInput2.productType;
        productPatch.vendor = productInput2.vendor;
        productPatch.tags = productInput2.tags;
        productPatch.metafields = productInput2.metafields;
        productPatch.seo = productInput2.seo;
      } else {
        // update mode: only fields selected in updateOpts
        if (updateOpts.has("name")) productPatch.title = productInput2.title;
        if (updateOpts.has("description")) {
          productPatch.descriptionHtml = productInput2.descriptionHtml;
          productPatch.seo = productInput2.seo;
        }
        if (updateOpts.has("vendor")) productPatch.vendor = productInput2.vendor;
        if (updateOpts.has("productType")) productPatch.productType = productInput2.productType;
        if (updateOpts.has("tags")) productPatch.tags = productInput2.tags;
        if (updateOpts.has("metafields")) productPatch.metafields = productInput2.metafields;
      }
      if (Object.keys(productPatch).length > 1) {
        const updateRes = await graphqlWithRetry(admin,
          `#graphql
          mutation productUpdate($product: ProductUpdateInput!) {
            productUpdate(product: $product) { product { id } userErrors { field message } }
          }`,
          { product: productPatch }
        );
        if (updateRes.data?.productUpdate?.userErrors?.length) {
          const updateErrors = updateRes.data.productUpdate.userErrors;
          const notFound = updateErrors.some((e: any) =>
            e.message?.includes("not find") || e.message?.includes("NOT_FOUND") || e.message?.includes("was not found")
          );
          if (notFound) {
            return;
          }
          console.error(`[Import] Priority replace: productUpdate errors:`, JSON.stringify(updateErrors));
        }
      }
    } catch (e: any) {
      console.error(`[Import] Priority replace: productUpdate failed for ${priorityReplaceTarget.shopifyProductId}:`, e?.message);
    }

    // Update variant: SKU + price + compareAt + barcode
    let variantId2: string | undefined;
    let invItemId2: string | undefined;
    const rowEanForReplace = getField(row, columnMaps, "ean") || row["ean"] || "";
    try {
      const variantRes2 = await graphqlWithRetry(admin,
        `#graphql
        query { product(id: "${priorityReplaceTarget.shopifyProductId}") {
          variants(first: 1) { edges { node { id inventoryItem { id } } } }
        }}`,
        {}
      );
      variantId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.id;
      invItemId2 = variantRes2.data?.product?.variants?.edges?.[0]?.node?.inventoryItem?.id;
    } catch (e: any) {
      console.error(`[Import] Priority replace: variants query failed for ${priorityReplaceTarget.shopifyProductId}:`, e?.message);
    }
    if (variantId2 && updateOpts.has("price")) {
      try {
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
      } catch (e: any) {
        console.error(`[Import] Priority replace: variantBulkUpdate failed for ${priorityReplaceTarget.shopifyProductId}:`, e?.message);
      }
      if (sku && matchModePR === "overwrite") {
        try {
          await updateVariantSku(shopDomain, priorityReplaceTarget.shopifyProductId, variantId2, sku);
        } catch (e: any) {
          console.error("[Import] Priority replace: error updating SKU:", e?.message);
        }
      }
    }

    // Update stock at configured location (only if stock selected)
    if (updateOpts.has("stock") && invItemId2 && locationId) {
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

    // Update images — incremental (only add, never delete)
    let newShopifyImages3: string | null = null;
    if (updateOpts.has("images") && productInput2.files && productInput2.files.length > 0) {
      try {
        const prMapping = priorityReplaceTarget.mappingId
          ? await prisma.productMapping.findUnique({ where: { id: priorityReplaceTarget.mappingId }, select: { shopifyImages: true } }).catch(() => null)
          : null;
        const storedImgs3: StoredImage[] = prMapping?.shopifyImages ? JSON.parse(prMapping.shopifyImages) : [];
        const imgResult = await incrementalImageUpdate(
          admin, shopDomain, priorityReplaceTarget.shopifyProductId, sku,
          productInput2.files.map((f: any) => ({ originalSource: f.originalSource, alt: f.alt, contentType: f.contentType || "IMAGE" })),
          `SKU=${sku} (priority replace)`,
          storedImgs3,
        );
        if (imgResult.changed) {
          result.imageChanges++;
          newShopifyImages3 = JSON.stringify(imgResult.newImages);
        }
      } catch (error: any) {
        console.error(`[Import] Priority replace: error updating images:`, error?.message);
      }
    }

    // Delete old mapping (overwrite only), upsert new one
    if (matchModePR === "overwrite" && priorityReplaceTarget.mappingId) {
      try { await prisma.productMapping.delete({ where: { id: priorityReplaceTarget.mappingId } }); } catch {}
    }
    const newMapping2 = await prisma.productMapping.upsert({
      where: { shopDomain_supplierSku: { shopDomain, supplierSku: sku } },
      create: {
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
        lastTitle: productInput2.title ?? null,
        lastDescription: productInput2.descriptionHtml ?? null,
        lastVendor: productInput2.vendor ?? null,
        lastProductType: productInput2.productType ?? null,
        lastTags: productInput2.tags?.length ? normalizeTags(productInput2.tags) : null,
        lastImportSource: sourceKey,
        ...(newShopifyImages3 ? { shopifyImages: newShopifyImages3 } : {}),
      },
      update: {
        configId: config.id,
        ean: rowEanForReplace || null,
        shopifyProductId: priorityReplaceTarget.shopifyProductId,
        shopifyVariantId: variantId2 || null,
        shopifyInventoryItemId: invItemId2 || null,
        lastPrice: prices2.regularPrice,
        lastComparePrice: prices2.compareAtPrice,
        lastQuantity: newQty,
        lastCost: costPrice > 0 ? costPrice : null,
        ...(matchModePR === "overwrite" ? {
          lastTitle: productInput2.title ?? undefined,
          lastDescription: productInput2.descriptionHtml ?? undefined,
          lastVendor: productInput2.vendor ?? undefined,
          lastProductType: productInput2.productType ?? undefined,
          lastTags: productInput2.tags?.length ? normalizeTags(productInput2.tags) : undefined,
        } : {}),
        lastImportSource: sourceKey,
        ...(newShopifyImages3 ? { shopifyImages: newShopifyImages3 } : {}),
      },
    });
    existing = newMapping2;
    // Auto-resolve duplicate logs for this EAN after priority replace
    try {
      if (rowEanForReplace) {
        await prisma.duplicateLog.deleteMany({
          where: { shopDomain, ean: rowEanForReplace },
        });
      }
    } catch {}
    result.updated++;
    return;
  }

  // === SINGLE UPDATE PATH ===
  // Verify product still exists in Shopify (orphan detection)
  if (existing) {
    const exists = await verifyProductExists(admin, existing.shopifyProductId);
    if (!exists) {
      await prisma.productMapping.delete({ where: { id: existing.id } });
      existing = null;
    }
  }

  // Recover variantId/inventoryItemId if missing (e.g. Path C variants query failed)
  if (existing && (!existing.shopifyVariantId || !existing.shopifyInventoryItemId)) {
    try {
      const variantRecovery = await graphqlWithRetry(admin,
        `#graphql query { product(id: "${existing.shopifyProductId}") {
          variants(first: 1) { edges { node { id inventoryItem { id } } } }
        }}`, {}
      );
      const vId = variantRecovery.data?.product?.variants?.edges?.[0]?.node?.id;
      const invId = variantRecovery.data?.product?.variants?.edges?.[0]?.node?.inventoryItem?.id;
      console.log(`[Import] Recovery SKU=${sku}: variantId=${vId || "null"} inventoryItemId=${invId || "null"} (was: variantId=${existing.shopifyVariantId || "null"} inventoryItemId=${existing.shopifyInventoryItemId || "null"})`);
      if (vId || invId) {
        await prisma.productMapping.update({
          where: { id: existing.id },
          data: { shopifyVariantId: vId || null, shopifyInventoryItemId: invId || null },
        });
        if (vId) existing.shopifyVariantId = vId;
        if (invId) existing.shopifyInventoryItemId = invId;
      }
    } catch (e: any) {
      console.error(`[Import] Recovery FAILED SKU=${sku} product=${existing.shopifyProductId}:`, e?.message);
    }
  }

  let descDebugCount = 0;
  if (existing) {
    // Fetch live product + variant + inventory data from Shopify FIRST
    let liveProduct: any = null;
    let liveVariantPrice: string | null = null;
    let liveVariantSku: string | null = null;
    let liveInventoryQuantity: number | null = null;
    let liveCost: number | null = null;
    try {
      const liveRes = await graphqlWithRetry(admin,
        `#graphql
        query liveProduct($id: ID!) {
          product(id: $id) {
            title
            descriptionHtml
            vendor
            productType
            tags
            variants(first: 1) {
              edges { node { price sku } }
            }
          }
        }`,
        { id: existing.shopifyProductId }
      );
      liveProduct = liveRes.data?.product;
      liveVariantPrice = liveProduct?.variants?.edges?.[0]?.node?.price ?? null;
      liveVariantSku = liveProduct?.variants?.edges?.[0]?.node?.sku ?? null;
    } catch (err: any) {
      console.error(`[Import] SKU ${sku}: liveProduct query FAILED, falling back to cached data. Error: ${err?.message || err}`);
    }

    if (existing.shopifyInventoryItemId && locationId) {
      try {
        liveInventoryQuantity = await getCurrentStock(admin, existing.shopifyInventoryItemId, locationId);
      } catch {}
      try {
        const costRes = await graphqlWithRetry(admin,
          `#graphql
          query liveCost($id: ID!) {
            inventoryItem(id: $id) {
              unitCost { amount currencyCode }
            }
          }`,
          { id: existing.shopifyInventoryItemId }
        );
        liveCost = parseFloat(costRes.data?.inventoryItem?.unitCost?.amount ?? "0") || 0;
      } catch {}
    }

    const liveTitle = liveProduct?.title ?? existing.lastTitle ?? null;
    const liveDescription = liveProduct?.descriptionHtml ?? existing.lastDescription ?? null;
    const liveVendor = liveProduct?.vendor ?? existing.lastVendor ?? null;
    const liveProductType = liveProduct?.productType ?? existing.lastProductType ?? null;
    const liveTags = liveProduct?.tags ?? shopifyLiveTags ?? null;

    // === CHANGE DETECTION: compare against LIVE Shopify data ===

    const priceChanged = updateOpts.has("price") && liveVariantPrice !== null && Math.abs(prices.regularPrice - parseFloat(liveVariantPrice)) > 0.01;
    const stockChanged = updateOpts.has("stock") && existing.shopifyInventoryItemId && newQty !== (liveInventoryQuantity ?? existing.lastQuantity);
    const costChanged = costPrice > 0 && existing.shopifyInventoryItemId && Math.abs((liveCost ?? 0) - costPrice) > 0.001;

    if (!stockChanged && updateOpts.has("stock") && !existing.shopifyInventoryItemId) {
      console.log(`[Import] SKU ${sku}: stock SKIPPED — shopifyInventoryItemId is null`);
    }

    const weightValue = parseFloat((getField(row, columnMaps, "weight") || "0").replace(",", "."));
    const shouldSendWeight = weightValue > 0 && existing.shopifyInventoryItemId;

    const imagesChanged = updateOpts.has("images") && (productInput.files?.length ?? 0) > 0;

    const titleChanged = updateOpts.has("name") && productInput.title && stripInvisible(productInput.title) !== stripInvisible(liveTitle);
    const csvDescNorm = normalizeHtml(productInput.descriptionHtml ?? "");
    const liveDescNorm = normalizeHtml(liveDescription ?? "");
    const descriptionChanged = updateOpts.has("description") && productInput.descriptionHtml && csvDescNorm !== liveDescNorm;
    const vendorChanged = updateOpts.has("vendor") && productInput.vendor && productInput.vendor !== liveVendor;
    const productTypeChanged = updateOpts.has("productType") && productInput.productType && productInput.productType !== liveProductType;
    const tagsBaseline = liveTags != null
      ? normalizeTags(Array.isArray(liveTags) ? liveTags : liveTags.split(","))
      : existing.lastTags ?? null;
    const tagsChanged = updateOpts.has("tags") && productInput.tags?.length && normalizeTags(productInput.tags as string[]) !== tagsBaseline;
    if (tagsChanged) {
      console.log(`[Import] SKU ${sku}: TAGS CHANGED baseline=${tagsBaseline} new=${normalizeTags(productInput.tags as string[])} liveTags=${JSON.stringify(liveTags)}`);
    }
    if (titleChanged) {
      console.log(`[Import] SKU ${sku}: TITLE CHANGED liveTitle=${JSON.stringify(liveTitle)} csvTitle=${JSON.stringify(productInput.title)}`);
    }

    // === COLLECTIONS: always sync (idempotent) even if nothing else changed ===
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

        const desiredIds = productInput.collections.filter((c: any) => typeof c === "string" && c.startsWith("gid://"));
        const toRemove = currentCollections.filter((id: string) => !desiredIds.includes(id));
        const toAdd = desiredIds.filter((id: string) => !currentCollections.includes(id));

        for (const colId of toRemove) {
          await graphqlWithRetry(admin,
            `#graphql
            mutation collectionRemove($id: ID!, $productIds: [ID!]!) {
              collectionRemoveProducts(id: $id, productIds: $productIds) {
                userErrors { field message }
              }
            }`,
            { id: colId, productIds: [existing.shopifyProductId] }
          );
        }
        for (const colId of toAdd) {
          const addRes = await graphqlWithRetry(admin,
            `#graphql
            mutation collectionAdd($id: ID!, $productIds: [ID!]!) {
              collectionAddProducts(id: $id, productIds: $productIds) {
                userErrors { field message }
              }
            }`,
            { id: colId, productIds: [existing.shopifyProductId] }
          );
          const addErrors = addRes.data?.collectionAddProducts?.userErrors || [];
          if (addErrors.length > 0) {
            console.error(`[Import] SKU ${sku}: collectionAdd errors for ${colId}:`, JSON.stringify(addErrors));
          }
        }
      } catch (error: any) {
        console.error("[Import] Error actualizando colecciones:", error?.message || error);
      }
    }

    // Images in update: incremental (fileDelete + productUpdate)
    // First check if saved CSV URLs match current CSV URLs — skip if identical
    let newShopifyImages4: string | null = null;
    if (updateOpts.has("images") && productInput.files?.length) {
      try {
        const currentCsvUrls = productInput.files.map((f: any) => f.originalSource);
        const savedImages: StoredImage[] = existing.shopifyImages ? JSON.parse(existing.shopifyImages) : [];
        const savedCsvUrls = savedImages.map((img: StoredImage) => img.url);

        const csvUnchanged = savedCsvUrls.length === currentCsvUrls.length &&
          savedCsvUrls.every((url: string, i: number) => url === currentCsvUrls[i]);

        if (csvUnchanged && savedCsvUrls.length > 0) {
          // Images haven't changed — skip expensive Shopify query
        } else {
          const imgResult = await incrementalImageUpdate(
            admin, shopDomain, existing.shopifyProductId, sku,
            productInput.files.map((f: any) => ({ originalSource: f.originalSource, alt: f.alt, contentType: f.contentType || "IMAGE" })),
            `SKU=${sku} (standard update)`,
            savedImages,
          );
          if (imgResult.changed) {
            result.imageChanges++;
            newShopifyImages4 = JSON.stringify(imgResult.newImages);
          }
        }
      } catch (error: any) {
        console.error(`[Import] Standard update: error updating images:`, error?.message);
      }
    }

    // Skip productUpdate/price/stock if nothing changed
    // NOTE: images are handled BEFORE this check, so imagesChanged is NOT included here
    const overwriteModeEarly = (shopSettings0?.matchMode || "overwrite") === "overwrite";
    const skuChangedEarly = overwriteModeEarly && existing.shopifyVariantId && sku && sku !== (liveVariantSku || existing.supplierSku);
    if (!priceChanged && !stockChanged && !costChanged && !titleChanged && !descriptionChanged && !vendorChanged && !productTypeChanged && !tagsChanged && !skuChangedEarly) {
      if (newShopifyImages4) {
        // Only images changed — save pairing and count as updated (not unchanged)
        try {
          await prisma.productMapping.update({
            where: { id: existing.id },
            data: { lastSyncAt: new Date(), shopifyImages: newShopifyImages4 },
          });
        } catch {}
        result.updated++;
      } else {
        result.unchanged++;
      }
      return;
    }

    if (priceChanged) result.priceChanges++;
    if (stockChanged) result.stockChanges++;
    if (costChanged) result.costChanges++;
    if (titleChanged) result.titleChanges++;
    if (descriptionChanged) result.descriptionChanges++;
    if (vendorChanged) result.vendorChanges++;
    if (productTypeChanged) result.productTypeChanges++;
    if (tagsChanged) result.tagsChanges++;
    // NOTE: imageChanges is counted inside the image dedup block (line ~1842)

    const productPatch: any = { id: existing.shopifyProductId };
    if (updateOpts.has("name")) productPatch.title = productInput.title;
    if (updateOpts.has("description")) {
      productPatch.descriptionHtml = productInput.descriptionHtml;
      productPatch.seo = productInput.seo;
    }
    if (updateOpts.has("productType")) productPatch.productType = productInput.productType;
    if (updateOpts.has("vendor")) productPatch.vendor = productInput.vendor;
    if (updateOpts.has("tags") && productInput.tags?.length) productPatch.tags = productInput.tags;
    if (updateOpts.has("metafields")) {
      productPatch.metafields = productInput.metafields;
    } else {
      const costMeta = productInput.metafields?.filter((m) => m.key === "costo");
      if (costMeta?.length) productPatch.metafields = costMeta;
    }

    if (Object.keys(productPatch).length > 1) {
      console.log(`[Import] SKU ${sku}: productUpdate with keys=${Object.keys(productPatch).join(",")} price=${priceChanged} stock=${stockChanged} cost=${costChanged} title=${titleChanged} desc=${descriptionChanged} vendor=${vendorChanged} pt=${productTypeChanged} tags=${tagsChanged} sku=${skuChangedEarly}`);
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
        await prisma.productMapping.delete({ where: { id: existing.id } });
        result.created++;
        return;
      }
    }

    const overwriteMode = (shopSettings0?.matchMode || "overwrite") === "overwrite";
    const skuChanged = overwriteMode && existing.shopifyVariantId && sku && sku !== (liveVariantSku || existing.supplierSku);

    if (priceChanged && existing.shopifyVariantId) {
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
            id: existing.shopifyVariantId,
            price: String(isNaN(prices.regularPrice) ? 0 : prices.regularPrice),
            compareAtPrice: prices.compareAtPrice && !isNaN(prices.compareAtPrice) ? String(prices.compareAtPrice) : null,
            barcode: ean,
          }],
        }
      );
    }

    if (skuChanged) {
      try {
        await updateVariantSku(shopDomain, existing.shopifyProductId, existing.shopifyVariantId!, sku);
        console.log(`[Import] SKU ${sku}: overwritten SKU on variant ${existing.shopifyVariantId}`);
      } catch (error: any) {
        console.error(`[Import] SKU update failed for ${sku}:`, error?.message || error);
      }
    }

    if (stockChanged && existing.shopifyInventoryItemId) {
      if (config.skipZeroStockCreate && newQty <= 0) {
      } else if (processedInventoryItems.has(existing.shopifyInventoryItemId)) {
      } else {
        processedInventoryItems.add(existing.shopifyInventoryItemId);
        try {
          await setStock(admin, existing.shopifyInventoryItemId, locationId, newQty, sku);
        } catch (error: any) {
          console.error("[Import] Error ajustando inventario:", error);
        }
      }
    } else if (stockChanged) {
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

    if (shouldSendWeight && existing.shopifyInventoryItemId) {
      console.log(`[Import] SKU ${sku}: updating weight=${weightValue}`);
      try {
        console.log(`[Import] SKU ${sku}: updating weight=${weightValue} on inventoryItem=${existing.shopifyInventoryItemId}`);
        await graphqlWithRetry(admin,
          `#graphql
          mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
            inventoryItemUpdate(id: $id, input: $input) {
              inventoryItem { id measurement { weight { value unit } } }
              userErrors { field message }
            }
          }`,
          {
            id: existing.shopifyInventoryItemId,
            input: { measurement: { weight: { value: weightValue, unit: "KILOGRAMS" } } },
          }
        );
      } catch (error: any) {
        console.error("[Import] Error seteando peso:", error?.message || error);
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
          lastTitle: productInput.title ?? undefined,
          lastDescription: productInput.descriptionHtml ?? undefined,
          lastVendor: productInput.vendor ?? undefined,
          lastProductType: productInput.productType ?? undefined,
          lastTags: productInput.tags?.length ? normalizeTags(productInput.tags) : undefined,
          lastSyncAt: new Date(),
          ...(newShopifyImages4 ? { shopifyImages: newShopifyImages4 } : {}),
        },
      });
    } catch {}

    // Auto-resolve duplicate logs when adopting via priority (single update path)
    try {
      const resolveEan = getField(row, columnMaps, "ean") || row["ean"] || "";
      if (resolveEan) {
        await prisma.duplicateLog.deleteMany({
          where: { shopDomain, ean: resolveEan },
        });
      }
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
    const weightValue = parseFloat((getField(row, columnMaps, "weight") || "0").replace(",", "."));

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
          inventoryItem: { tracked: true, ...(weightValue > 0 ? { measurement: { weight: { value: weightValue, unit: "KILOGRAMS" } } } : {}) },
          inventoryQuantities: [
            {
              locationId,
              name: "available",
              quantity: Math.max(0, parseInt((getField(row, columnMaps, "quantity") || row["quantity"] || "0").replace(",", ".")) || 0),
            },
          ],
        },
      ],
    };


    const json = await graphqlWithRetry(admin,
      `#graphql
      mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
        productSet(input: $input, synchronous: $synchronous) {
          product {
            id
            media(first: 10) {
              nodes {
                id
                status
                ... on MediaImage {
                  image { url }
                }
              }
            }
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
      await prisma.productMapping.upsert({
        where: { shopDomain_supplierSku: { shopDomain, supplierSku: sku } },
        create: {
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
          lastTitle: productInput.title ?? null,
          lastDescription: productInput.descriptionHtml ?? null,
          lastVendor: productInput.vendor ?? null,
          lastProductType: productInput.productType ?? null,
          lastTags: productInput.tags?.length ? normalizeTags(productInput.tags) : null,
          lastImportSource: sourceKey,
          ...(productInput.files?.length ? { shopifyImages: JSON.stringify(productInput.files.map((f: any) => ({ mediaId: "", url: f.originalSource }))) } : {}),
        },
        update: {
          configId: config.id,
          ean: rowEan || null,
          shopifyProductId: productId,
          shopifyVariantId: variant?.id ?? null,
          shopifyInventoryItemId: inventoryItemId,
          lastPrice: prices.regularPrice,
          lastComparePrice: prices.compareAtPrice,
          lastQuantity: newQty,
          lastCost: costPrice > 0 ? costPrice : null,
          lastTitle: productInput.title ?? undefined,
          lastDescription: productInput.descriptionHtml ?? undefined,
          lastVendor: productInput.vendor ?? undefined,
          lastProductType: productInput.productType ?? undefined,
          lastTags: productInput.tags?.length ? normalizeTags(productInput.tags) : undefined,
          lastImportSource: sourceKey,
          ...(productInput.files?.length ? { shopifyImages: JSON.stringify(productInput.files.map((f: any) => ({ mediaId: "", url: f.originalSource }))) } : {}),
        },
      });

      // T2b: media IDs de la propia respuesta productSet (ejemplo oficial
      // "Create a product and associate files") → sin sleep(2000) ni query extra.
      // Si Shopify no devuelve nodes (raro), se resuelve en el post-pasada.
      if (productInput.files?.length) {
        try {
          const mediaNodes: any[] = json.data?.productSet?.product?.media?.nodes || [];
          const withId = mediaNodes.filter((n: any) => n?.id);
          if (withId.length > 0) {
            const csvFiles = productInput.files.map((f: any) => f.originalSource);
            const stored: StoredImage[] = withId.map((m: any, i: number) => ({
              mediaId: m.id,
              url: csvFiles[i] || m.image?.url || "",
            }));
            await prisma.productMapping.updateMany({
              where: { shopDomain, shopifyProductId: productId },
              data: { shopifyImages: JSON.stringify(stored) },
            });
          } else {
            mediaToResolve.push({
              productId,
              csvFiles: productInput.files.map((f: any) => f.originalSource),
            });
          }
        } catch {}
      }
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
        }
      } catch (error: any) {
        console.error(`[Import] SKU ${sku}: error publicando: ${error?.message}`);
      }
    } else {
    }

    result.created++;
  }
}
