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
}

const cache = new Map<string, CacheEntry>();
const rowCache = new Map<string, RowCacheEntry>();
const MAX_ENTRIES = 50;
const MAX_ROW_ENTRIES = 10;
const TTL_MS = 60 * 60 * 1000;

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
  for (const key of rowCache.keys()) {
    if (key.startsWith(configId + "|")) {
      rowCache.delete(key);
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

  if (search) {
    const searchLower = search.toLowerCase();
    return result.filter(
      (s) => s.value.toLowerCase().includes(searchLower) || s.label.toLowerCase().includes(searchLower) || (s.ean && s.ean.toLowerCase().includes(searchLower))
    );
  }

  return result;
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
      console.log(`[CsvCache] Rows hit: ${cached.rows.length} rows for ${configId}`);
      return { rows: cached.rows, headers: cached.headers };
    }
  } else {
    rowCache.delete(key);
    console.log(`[CsvCache] Force refresh: cache cleared for ${configId}`);
  }

  console.log(`[CsvCache] Rows miss: parsing ${url}`);
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
  console.log(`[CsvCache] Parsed ${rows.length} rows in ${elapsed}s (error=${streamError || "none"})`);

  // Don't cache if stream errored with partial data — next request will retry
  if (streamError && rows.length > 0) {
    console.warn(`[CsvCache] NOT caching ${rows.length} partial rows due to stream error — will retry next request`);
    return { rows, headers };
  }

  // Evict oldest row cache entries
  if (rowCache.size >= MAX_ROW_ENTRIES) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [k, v] of rowCache) {
      if (v.createdAt < oldestTime) {
        oldestTime = v.createdAt;
        oldestKey = k;
      }
    }
    if (oldestKey) rowCache.delete(oldestKey);
  }

  rowCache.set(key, { rows, headers, createdAt: Date.now() });
  return { rows, headers };
}

export function getCacheStats(): { entries: number; maxEntries: number; ttlMs: number } {
  return { entries: cache.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS };
}
