import fs from "node:fs/promises";
import path from "node:path";
import { streamFile } from "./csv-parser.server";

interface CacheEntry {
  categories: string[];
  brands: string[];
  skus: Array<{ value: string; label: string; ean: string }>;
  headers: string[];
  totalRows: number;
  createdAt: number;
}

interface RowCacheEntry {
  rows: Array<Record<string, string | undefined>>;
  headers: string[];
  createdAt: number;
  byteSize: number;
}

const cache = new Map<string, CacheEntry>();
const rowCache = new Map<string, RowCacheEntry>();
const MAX_ENTRIES = 50;
const MAX_ROW_ENTRIES = 10;
// Cap de memoria: solo LRU por entradas no limita nada — 10 feeds completos
// (miles de filas × ~30 columnas) podían ocupar cientos de MB en RAM.
const MAX_ROW_CACHE_BYTES = 64 * 1024 * 1024;
let rowCacheBytes = 0;
const TTL_MS = 60 * 60 * 1000;

function estimateRowCacheBytes(
  rows: Array<Record<string, string | undefined>>,
  headers: string[]
): number {
  // Heurística: longitud de celdas + overhead por celda (clave del objeto V8)
  let bytes = 0;
  for (const row of rows) {
    for (const h of headers) bytes += (row[h]?.length || 0) + 32;
  }
  return bytes;
}

function deleteRowCache(key: string): void {
  const entry = rowCache.get(key);
  if (entry) {
    rowCacheBytes -= entry.byteSize;
    rowCache.delete(key);
  }
}

function evictOldestRowCache(protectKey?: string): void {
  let oldestKey = "";
  let oldestTime = Infinity;
  for (const [k, v] of rowCache) {
    if (k === protectKey) continue;
    if (v.createdAt < oldestTime) {
      oldestTime = v.createdAt;
      oldestKey = k;
    }
  }
  if (oldestKey) deleteRowCache(oldestKey);
}

function makeCacheKey(configId: string, url: string, delimiter: string): string {
  return `${configId}|${url}|${delimiter}`;
}

function isExpired(entry: CacheEntry): boolean {
  return Date.now() - entry.createdAt > TTL_MS;
}

function evictOldest(): void {
  if (cache.size <= MAX_ENTRIES) return;
  let oldestKey = "";
  let oldestTime = Infinity;
  for (const [key, entry] of cache) {
    if (entry.createdAt < oldestTime) {
      oldestTime = entry.createdAt;
      oldestKey = key;
    }
  }
  if (oldestKey) cache.delete(oldestKey);
}

// Dedup in-flight: peticiones concurrentes para la misma clave comparten un
// único stream (evita descargar el feed N veces si el usuario hace clic varias
// veces antes de que responda). Si la promesa falla, se elimina para que el
// siguiente intento relance la descarga (sin envenenar la caché).
const inflight = new Map<string, Promise<unknown>>();

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

export async function getFileModTime(url: string): Promise<string> {
  try {
    if (url.startsWith("/") || url.match(/^[A-Z]:\\/i)) {
      const stat = await fs.stat(url);
      return stat.mtimeMs.toString();
    }
  } catch {}
  return "";
}

export function invalidateCache(configId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(configId + "|")) {
      cache.delete(key);
    }
  }
  for (const key of [...rowCache.keys()]) {
    if (key.startsWith(configId + "|")) {
      deleteRowCache(key);
    }
  }
}

export async function getCachedCategories(
  configId: string,
  url: string,
  delimiter: string,
  columnName: string = "category"
): Promise<string[]> {
  const modTime = await getFileModTime(url);
  const key = makeCacheKey(configId, url, delimiter) + `|cat|${columnName}|${modTime}`;

  const cached = cache.get(key);
  if (cached && !isExpired(cached)) return cached.categories;

  return dedupe(key, async () => {
    const categories = new Set<string>();
    for await (const { row } of streamFile(url, delimiter)) {
      const val = (row[columnName] || "").trim();
      if (val) categories.add(val);
    }
    const result = [...categories].sort();

    evictOldest();
    const existing = cache.get(key);
    cache.set(key, {
      ...(existing || { brands: [], skus: [], headers: [], totalRows: 0, createdAt: Date.now() }),
      categories: result,
      createdAt: Date.now(),
    });

    return result;
  });
}

export async function getCachedBrands(
  configId: string,
  url: string,
  delimiter: string,
  columnName: string = "brand"
): Promise<string[]> {
  const modTime = await getFileModTime(url);
  const key = makeCacheKey(configId, url, delimiter) + `|brand|${columnName}|${modTime}`;

  const cached = cache.get(key);
  if (cached && !isExpired(cached)) return cached.brands;

  return dedupe(key, async () => {
    const brands = new Set<string>();
    for await (const { row } of streamFile(url, delimiter)) {
      const val = (row[columnName] || "").trim();
      if (val) brands.add(val);
    }
    const result = [...brands].sort();

    evictOldest();
    const existing = cache.get(key);
    cache.set(key, {
      ...(existing || { categories: [], skus: [], headers: [], totalRows: 0, createdAt: Date.now() }),
      brands: result,
      createdAt: Date.now(),
    });

    return result;
  });
}

export async function getCachedSkus(
  configId: string,
  url: string,
  delimiter: string,
  skuColumn: string = "sku",
  titleColumn: string = "name",
  search?: string,
  eanColumn?: string
): Promise<Array<{ value: string; label: string; ean: string }>> {
  const modTime = await getFileModTime(url);
  const key = makeCacheKey(configId, url, delimiter) + `|sku|${modTime}`;

  const cached = cache.get(key);
  if (cached && !isExpired(cached) && !search) return cached.skus;

  if (cached && !isExpired(cached) && search) {
    const searchLower = search.toLowerCase();
    return cached.skus.filter(
      (s) => s.value.toLowerCase().includes(searchLower) || s.label.toLowerCase().includes(searchLower) || (s.ean && s.ean.toLowerCase().includes(searchLower))
    );
  }

  const seen = new Map<string, { name: string; ean: string }>();
  let validSkuCol = skuColumn;
  let validTitleCol = titleColumn;
  let validEanCol = eanColumn || "ean";
  let headersValidated = false;

  const full = await dedupe(key, async () => {
    for await (const { headers, row } of streamFile(url, delimiter)) {
      if (!headersValidated) {
        headersValidated = true;
        if (!headers.includes(validSkuCol)) {
          validSkuCol = headers.find((h) => h === "sku") || headers[0] || "sku";
        }
        if (!headers.includes(validTitleCol)) {
          validTitleCol = headers.find((h) => h === "name") || "name";
        }
        if (!headers.includes(validEanCol)) {
          validEanCol = headers.find((h) => h === "ean") || "";
        }
      }
      const sku = (row[validSkuCol] || "").trim();
      if (!sku) continue;
      const name = (row[validTitleCol] || "").trim();
      const ean = validEanCol ? (row[validEanCol] || "").trim() : "";
      if (!seen.has(sku)) {
        seen.set(sku, { name, ean });
      }
    }

    const result = [...seen.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sku, data]) => ({
        value: sku,
        label: data.name ? `${sku} — ${data.name}` : sku,
        ean: data.ean,
      }));

    evictOldest();
    cache.set(key, {
      categories: [],
      brands: [],
      skus: result,
      headers: [],
      totalRows: result.length,
      createdAt: Date.now(),
    });

    return result;
  });

  if (search) {
    const searchLower = search.toLowerCase();
    return full.filter(
      (s) => s.value.toLowerCase().includes(searchLower) || s.label.toLowerCase().includes(searchLower) || (s.ean && s.ean.toLowerCase().includes(searchLower))
    );
  }

  return full;
}

export async function getCachedHeaders(
  configId: string,
  url: string,
  delimiter: string
): Promise<string[]> {
  const modTime = await getFileModTime(url);
  const key = makeCacheKey(configId, url, delimiter) + `|headers|${modTime}`;

  const cached = cache.get(key);
  if (cached && !isExpired(cached)) return cached.headers;

  return dedupe(key, async () => {
    let headers: string[] = [];
    for await (const { headers: h } of streamFile(url, delimiter)) {
      headers = h;
      break;
    }

    evictOldest();
    const existing = cache.get(key);
    cache.set(key, {
      ...(existing || { categories: [], brands: [], skus: [], totalRows: 0, createdAt: Date.now() }),
      headers,
      createdAt: Date.now(),
    });

    return headers;
  });
}

export async function getCachedCsvRows(
  configId: string,
  url: string,
  delimiter: string,
  forceRefresh: boolean = false
): Promise<{ rows: Array<Record<string, string | undefined>>; headers: string[] }> {
  const modTime = await getFileModTime(url);
  const key = makeCacheKey(configId, url, delimiter) + `|rows|${modTime}`;

  if (!forceRefresh) {
    const cached = rowCache.get(key);
    if (cached && Date.now() - cached.createdAt < TTL_MS) {
      return { rows: cached.rows, headers: cached.headers };
    }
  } else {
    deleteRowCache(key);
  }

  return dedupe(key, async () => {
    const startTime = Date.now();
    const rows: Array<Record<string, string | undefined>> = [];
    let headers: string[] = [];
    let streamError: string | null = null;

    try {
      for await (const item of streamFile(url, delimiter)) {
        if (headers.length === 0) headers = item.headers;
        rows.push(item.row);
      }
    } catch (e: any) {
      streamError = e?.message || String(e);
      console.error(`[CsvCache] Stream error after ${rows.length} rows: ${streamError}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Don't cache if stream errored with partial data — next request will retry
    if (streamError && rows.length > 0) {
      console.warn(`[CsvCache] NOT caching ${rows.length} partial rows due to stream error — will retry next request`);
      return { rows, headers };
    }

    // Entrada única más grande que todo el cap → no cachear (devolver datos
    // y listo; la próxima petición re-streama, igual que sin caché)
    const byteSize = estimateRowCacheBytes(rows, headers);
    if (byteSize > MAX_ROW_CACHE_BYTES) {
      console.warn(
        `[CsvCache] Entrada de ${rows.length} filas (~${Math.round(byteSize / (1024 * 1024))}MB) supera el cap de rowCache — no se cachea`
      );
      return { rows, headers };
    }

    // Reemplazo de posible entrada previa de la misma clave (TTL expirada)
    deleteRowCache(key);
    rowCache.set(key, { rows, headers, createdAt: Date.now(), byteSize });
    rowCacheBytes += byteSize;

    // Evict LRU hasta respetar límite de ENTRADAS y de BYTES
    // (nunca se echa la entrada recién insertada)
    while (
      (rowCache.size > MAX_ROW_ENTRIES || rowCacheBytes > MAX_ROW_CACHE_BYTES) &&
      rowCache.size > 1
    ) {
      evictOldestRowCache(key);
    }

    return { rows, headers };
  });
}

export function getCacheStats(): { entries: number; maxEntries: number; ttlMs: number } {
  return { entries: cache.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS };
}
