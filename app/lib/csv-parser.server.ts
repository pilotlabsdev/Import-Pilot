export interface ProductRow {
  [key: string]: string | undefined;
}

export interface StreamOptions {
  skuOf?: (row: ProductRow) => string;
  // Columnas CSV (en minúsculas) mapeadas a sku/ean en la pestaña Columnas.
  // El guard de cabeceras acepta un CSV sin "sku"/"ean" literal si el merchant
  // mapeó una columna no estándar (p.ej. "variant sku" del export de Shopify).
  mappedSkuColumns?: string[];
}

// Columnas crudas (lowercase) mapeadas a sku/ean en la pestaña Columnas.
// Acepta tanto el shape de Prisma ({shopifyField,csvColumn}) como el shape ya
// proyectado de los engines.
export function mappedSkuColumnsFrom(
  columnMaps: Array<{ shopifyField: string; csvColumn?: string | null }>
): string[] {
  const cols: string[] = [];
  for (const m of columnMaps) {
    if ((m.shopifyField === "sku" || m.shopifyField === "ean") && m.csvColumn) {
      cols.push(m.csvColumn.toLowerCase());
    }
  }
  return cols;
}

import * as XLSX from "xlsx";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Normaliza URLs de Google Sheets a su export CSV (en vivo, sin guardar nada):
 * - /spreadsheets/d/{id}/edit… → /export?format=csv[&gid=N] (gid de #gid= o ?gid=)
 * - /spreadsheets/d/e/{key}/pubhtml… → /pub?output=csv (doc oficial "Publish to web")
 * Idempotente: si ya es un export/pub CSV (format=csv/output=csv/tqx=out:csv) o no
 * es una URL de Sheets → se devuelve byte a byte intacta (cualquier otra URL,
 * incl. Mediamax/Drive/bucket/data:, nunca toca esta función).
 */
export function normalizeGoogleSheetsUrl(value: string): string {
  if (!value.includes("docs.google.com/spreadsheets")) return value;
  if (value.includes("format=csv") || value.includes("output=csv") || value.includes("tqx=out:csv")) return value;
  const pubMatch = value.match(/^(https?:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[a-zA-Z0-9_-]+\/)pubhtml(?:\?(.*))?/i);
  if (pubMatch) {
    const query = pubMatch[2] ? `&${pubMatch[2]}` : "";
    return `${pubMatch[1]}pub?output=csv${query}`;
  }
  const idMatch = value.match(/^(https?:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/)([a-zA-Z0-9_-]+)(?:\/|$)/i);
  if (idMatch && idMatch[2] !== "e") {
    const gidMatch = value.match(/[?&#]gid=(\d+)/);
    const gid = gidMatch ? `&gid=${gidMatch[1]}` : "";
    return `${idMatch[1]}${idMatch[2]}/export?format=csv${gid}`;
  }
  return value;
}

/**
 * 401/403 de Google (Sheets/Drive) = la hoja/archivo no está compartido → mensaje
 * accionable en vez del crudo "Error descargando CSV: 401 Unauthorized".
 * Devuelve null para cualquier otra URL/estado (el llamante usa su mensaje original).
 */
function googleDownloadError(url: string, status: number): string | null {
  if (status !== 401 && status !== 403) return null;
  if (!url.includes("docs.google.com") && !url.includes("drive.google.com")) return null;
  return "No se puede descargar de Google: la hoja o archivo no está compartido. Comparte la hoja con cualquiera que tenga el enlace.";
}

function isLocalFilePath(url: string): boolean {
  return url.startsWith("/") || url.match(/^[A-Z]:\\/i) !== null || url.startsWith("file:");
}

function detectEncoding(buffer: Uint8Array): string {
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return "utf-8";
  // <3 bytes: aún no se puede confirmar BOM ni detectar fiablemente → utf-8
  // (con stream:true el decoder une secuencias partidas entre chunks). Antes un
  // primer trozo partido con byte alto caía a latin1 → mojibake "ï»¿" en la
  // cabecera ("ï»¿sku" ≠ "sku") y el import seguía con todas las filas sin SKU.
  if (buffer.length < 3) return "utf-8";
  let hasHighBytes = false;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] > 127) { hasHighBytes = true; break; }
  }
  if (!hasHighBytes) return "utf-8";
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return "utf-8";
  } catch {
    return "latin1";
  }
}

async function fetchAsLocalUrl(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".csv": "text/csv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".ods": "application/vnd.oasis.opendocument.spreadsheetml.sheet",
  };
  const blob = new Blob([content], { type: mimeTypes[ext] || "text/csv" });
  return URL.createObjectURL(blob);
}

// Timeout SOLO para la fase de conexión/primeiros bytes (TTFB). El timer se
// cancela en cuanto fetch() resuelve, así el streaming del cuerpo (imports
// bulk/chunks) queda intacto. Medido 2026-09-30: el feed de api.mediamax.es
// genera el fichero antes de responder → TTFB real ≈ 35s, por eso el margen
// es de 120s (un fusible más apretado abortaría imports que sí funcionan).
// Un timeout NO se reintenta: si no responde en 120s, reintentar 2 veces más
// solo alargaría el fallo (el caller muestra el error y el job/usuario re-lanza).
const TTFB_TIMEOUT_MS = 120_000;

// Guard: N filas seguidas sin SKU → el feed no es utilizable (cabecera rota,
// variante basura del servidor, columnas desplazadas). Dentro del try de
// streamCSV → dispara sus reintentos (re-descarga) y, si persiste, falla el
// job de forma visible en vez de reportar "todo sin cambios".
const EMPTY_SKU_STREAK_LIMIT = 20;

async function fetchWithTtfbTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTFB_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function rethrowIfTimeout(error: any): void {
  if (error?.name === "AbortError") {
    throw new Error(`El servidor del feed no respondió tras ${TTFB_TIMEOUT_MS / 1000}s`);
  }
}

// Guard de causa raíz: una URL vacía llega a fetch("") y undici lanza un
// TypeError crudo ("Failed to parse URL from ") sin traducir. Se lanza una
// clave i18n directa (parseSystemError la pasa sin tocar).
function assertNonEmptyUrl(url: string): void {
  if (!url || !url.trim()) {
    throw new Error("systemError.empty_url");
  }
}

export function parseCSVLine(line: string, delimiter: string = "|"): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  // BOM utf-8 y su mojibake si la codificación se detectó mal (latin1)
  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
  else if (line.startsWith("ï»¿")) line = line.slice(3);

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
  }

  result.push(current.trim());
  return result;
}

export function autoDetectDelimiter(sample: string): string {
  const candidates = ["|", ",", ";", "\t"];
  let bestDelimiter = "|";
  let bestScore = -1;
  const lines = sample.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 20);
  if (lines.length === 0) return "|";

  for (const d of candidates) {
    const counts = lines.map((line) => {
      let count = 0;
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') inQuotes = !inQuotes;
        else if (line[i] === d && !inQuotes) count++;
      }
      return count;
    });
    const nonZeroCounts = counts.filter((c) => c > 0);
    if (nonZeroCounts.length < Math.ceil(lines.length * 0.5)) continue;
    const minCount = Math.min(...nonZeroCounts);
    const maxCount = Math.max(...nonZeroCounts);
    const avgCount = nonZeroCounts.reduce((a, b) => a + b, 0) / nonZeroCounts.length;
    const consistency = maxCount > 0 ? 1 - (maxCount - minCount) / (maxCount || 1) : 0;
    const score = avgCount * consistency * (nonZeroCounts.length / lines.length);
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = d;
    }
  }
  return bestDelimiter;
}

export async function* streamCSV(
  url: string,
  delimiter: string = "|",
  maxRetries: number = 3,
  opts?: StreamOptions
): AsyncGenerator<{ headers: string[]; row: ProductRow; lineNumber: number }> {
  assertNonEmptyUrl(url);
  // Normalize Google Drive URLs to bypass viewer/consent page
  if (url.includes("drive.google.com") && url.includes("export=download") && !url.includes("confirm=")) {
    url = `${url}&confirm=t`;
  }
  url = normalizeGoogleSheetsUrl(url);
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTtfbTimeout(url);
      if (!response.ok) {
        throw new Error(googleDownloadError(url, response.status) ?? `Error descargando CSV: ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No se pudo leer el stream del CSV");

      try {
        let buffer = "";
        let headers: string[] = [];
        let lineNumber = 0;
        let incompleteLine = "";
        let emptySkuStreak = 0;
        let effectiveDelimiter = delimiter === "auto" ? null : delimiter;

        const firstChunk = await reader.read();
        if (firstChunk.done) throw new Error("CSV vacío");
        const enc = detectEncoding(firstChunk.value);
        const decoder = new TextDecoder(enc);
        buffer += decoder.decode(firstChunk.value, { stream: true });

        // El buffer se procesa tras CADA decode (incluido el primer chunk): antes
        // solo se procesaba cuando llegaba un chunk 2, así que un cuerpo que llegaba
        // en un único read (CSV pequeño) se devolvía con 0 filas en silencio.
        let eof = false;
        while (true) {
          if (!eof) {
            const { done, value } = await reader.read();
            if (done) {
              // Flush remaining bytes from the decoder
              const remaining = decoder.decode();
              if (remaining) buffer += remaining;
              eof = true;
            } else {
              buffer += decoder.decode(value, { stream: true });
            }
          }

          if (!effectiveDelimiter && buffer.includes("\n")) {
            const sample = buffer.split("\n").slice(0, 20).join("\n");
            effectiveDelimiter = autoDetectDelimiter(sample);
          }

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const rawLine = incompleteLine ? incompleteLine + "\n" + line : line;
            incompleteLine = "";

            const trimmed = rawLine.trim();
            if (!trimmed) continue;

            let inQuotes = false;
            for (let i = 0; i < trimmed.length; i++) {
              const ch = trimmed[i];
              if (ch === '"') {
                if (i + 1 < trimmed.length && trimmed[i + 1] === '"') {
                  i++;
                } else {
                  inQuotes = !inQuotes;
                }
              }
            }

            if (inQuotes) {
              incompleteLine = rawLine;
              continue;
            }

            lineNumber++;

            if (lineNumber === 1) {
              headers = parseCSVLine(trimmed, effectiveDelimiter || "|").map((h) => h.toLowerCase());
              // Guard de import: solo aplica con skuOf (la ruta de lectura de
              // cabeceras/filtros no tiene por qué validar identificador). Acepta
              // "sku"/"ean" literal o columnas mapeadas en la pestaña Columnas
              // (p.ej. "variant sku" del export de Shopify).
              if (opts?.skuOf) {
                const required = ["sku", "ean"];
                const mapped = opts.mappedSkuColumns ?? [];
                const found = headers.some((h) => required.includes(h)) || mapped.some((c) => headers.includes(c));
                if (!found) {
                  throw new Error(`Cabeceras CSV no válidas: falta columna "sku" o "ean". Cabeceras encontradas: [${headers.slice(0, 10).join(", ")}...]`);
                }
              }
              continue;
            }

            const values = parseCSVLine(trimmed, effectiveDelimiter || "|");
            const row: ProductRow = {};

            headers.forEach((header, index) => {
              row[header] = values[index] || "";
            });

            if (opts?.skuOf) {
              if (opts.skuOf(row)) {
                emptySkuStreak = 0;
              } else if (++emptySkuStreak >= EMPTY_SKU_STREAK_LIMIT) {
                const detail = `Feed ilegible: ${EMPTY_SKU_STREAK_LIMIT} filas seguidas sin SKU (cerca de la línea ${lineNumber}). Cabeceras: [${headers.slice(0, 12).join(", ")}]`;
                console.error(`[CSV] ${detail}`);
                throw new Error(detail);
              }
            }

            yield { headers, row, lineNumber };
          }

          if (eof) break;
        }

        if (incompleteLine.trim()) {
          const trimmed = incompleteLine.trim();
          lineNumber++;
          if (lineNumber > 1) {
            const values = parseCSVLine(trimmed, effectiveDelimiter || "|");
            const row: ProductRow = {};
            headers.forEach((header, index) => {
              row[header] = values[index] || "";
            });
            yield { headers, row, lineNumber };
          }
        } else if (buffer.trim()) {
          lineNumber++;
          if (lineNumber > 1) {
            const values = parseCSVLine(buffer.trim(), effectiveDelimiter || "|");
            const row: ProductRow = {};
            headers.forEach((header, index) => {
              row[header] = values[index] || "";
            });
            yield { headers, row, lineNumber };
          }
        }

        return; // Success, exit retry loop
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch (error: any) {
      rethrowIfTimeout(error);
      lastError = error;
      if (attempt < maxRetries) {
        const wait = attempt * 2000;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastError || new Error("Error descargando CSV tras reintentos");
}

export async function* streamCSVFromBuffer(
  content: Buffer,
  delimiter: string = "|"
): AsyncGenerator<{ headers: string[]; row: ProductRow; lineNumber: number }> {
  const enc = detectEncoding(content);
  const decoder = new TextDecoder(enc);

  const text = decoder.decode(content);
  let headers: string[] = [];
  let lineNumber = 0;
  let incompleteLine = "";
  let effectiveDelimiter = delimiter === "auto" ? null : delimiter;

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  for (const rawLine of lines) {
    incompleteLine += rawLine;
    const trimmed = incompleteLine.trimEnd();
    const quoteCount = (trimmed.match(/"/g) || []).length;
    const inQuotes = quoteCount % 2 !== 0;

    if (inQuotes) {
      incompleteLine += "\n";
      continue;
    }

    const fullLine = trimmed;
    incompleteLine = "";

    if (fullLine.trim() === "") continue;

    if (effectiveDelimiter === null) {
      effectiveDelimiter = autoDetectDelimiter(fullLine);
    }

    lineNumber++;
    if (lineNumber === 1) {
      headers = parseCSVLine(fullLine.trim(), effectiveDelimiter || "|").map((h) => h.toLowerCase());
      continue;
    }

    const values = parseCSVLine(fullLine.trim(), effectiveDelimiter || "|");
    const row: ProductRow = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    yield { headers, row, lineNumber };
  }

  if (incompleteLine.trim()) {
    lineNumber++;
    if (lineNumber > 1) {
      const values = parseCSVLine(incompleteLine.trim(), effectiveDelimiter || "|");
      const row: ProductRow = {};
      headers.forEach((header, index) => {
        row[header] = values[index] || "";
      });
      yield { headers, row, lineNumber };
    }
  }
}

export async function* streamExcelFromBuffer(
  buffer: ArrayBuffer,
  maxRetries: number = 3
): AsyncGenerator<{ headers: string[]; row: ProductRow; lineNumber: number }> {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("El archivo Excel no tiene hojas");

  const sheet = workbook.Sheets[sheetName];
  const rawData: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
  });

  if (rawData.length === 0) return;

  let headerRowIndex = -1;
  let headers: string[] = [];

  for (let i = 0; i < Math.min(rawData.length, 30); i++) {
    const r = rawData[i];
    const nonEmpty = r.filter((c: any) => c !== null && c !== undefined && String(c).trim() !== "");
    if (nonEmpty.length >= 3) {
      const candidate = r.map((c: any) => String(c ?? "").trim());
      const hasMeaningful = candidate.some((h: string) =>
        h.length > 1 && !/^\d+$/.test(h) && !/^_empty/i.test(h)
      );
      if (hasMeaningful) {
        headerRowIndex = i;
        headers = candidate.map((h: string) => h.toLowerCase());
        break;
      }
    }
  }

  if (headerRowIndex === -1) {
    headers = rawData[0].map((c: any) => String(c ?? "").trim().toLowerCase());
    headerRowIndex = 0;
  }

  let lineNumber = 0;
  for (let i = headerRowIndex; i < rawData.length; i++) {
    const r = rawData[i];
    lineNumber++;
    if (lineNumber === 1) continue;
    const row: ProductRow = {};
    headers.forEach((header, index) => {
      row[header] = String(r[index] ?? "").trim();
    });
    yield { headers, row, lineNumber };
  }
}

export function isExcelUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".ods");
}

export async function* streamExcel(
  url: string,
  maxRetries: number = 3
): AsyncGenerator<{ headers: string[]; row: ProductRow; lineNumber: number }> {
  assertNonEmptyUrl(url);
  // Normalize Google Drive URLs to bypass viewer/consent page
  if (url.includes("drive.google.com") && url.includes("export=download") && !url.includes("confirm=")) {
    url = `${url}&confirm=t`;
  }
  url = normalizeGoogleSheetsUrl(url);
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTtfbTimeout(url);
      if (!response.ok) {
        throw new Error(googleDownloadError(url, response.status) ?? `Error descargando Excel: ${response.status} ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error("El archivo Excel no tiene hojas");

      const sheet = workbook.Sheets[sheetName];

      const rawData: any[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
        blankrows: false,
      });

      if (rawData.length === 0) return;

      let headerRowIndex = -1;
      let headers: string[] = [];

      for (let i = 0; i < Math.min(rawData.length, 30); i++) {
        const r = rawData[i];
        const nonEmpty = r.filter((c: any) => c !== null && c !== undefined && String(c).trim() !== "");
        if (nonEmpty.length >= 3) {
          const candidate = r.map((c: any) => String(c ?? "").trim());
          const hasMeaningful = candidate.some((h: string) =>
            h.length > 1 && !/^\d+$/.test(h) && !/^_empty/i.test(h)
          );
          if (hasMeaningful) {
            headerRowIndex = i;
            headers = candidate.map((h: string) => h.toLowerCase());
            break;
          }
        }
      }

      if (headerRowIndex === -1) {
        headers = rawData[0].map((c: any) => String(c ?? "").trim().toLowerCase());
        headerRowIndex = 0;
      }

      let lineNumber = 0;

      for (let i = headerRowIndex + 1; i < rawData.length; i++) {
        const rawRow = rawData[i];
        const allEmpty = rawRow.every((c: any) => c === null || c === undefined || String(c).trim() === "");
        if (allEmpty) continue;

        const firstCell = String(rawRow[0] ?? "").trim();
        if (headers.length > 0 && firstCell && !rawRow[1] && !rawRow[2]) continue;

        lineNumber++;
        const row: ProductRow = {};
        headers.forEach((header, index) => {
          if (!header) return;
          let val = rawRow[index];
          if (val instanceof Date) {
            val = val.toISOString().slice(0, 10);
          }
          row[header] = String(val ?? "");
        });
        yield { headers, row, lineNumber };
      }

      return;
    } catch (error: any) {
      rethrowIfTimeout(error);
      lastError = error;
      if (attempt < maxRetries) {
        const wait = attempt * 2000;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastError || new Error("Error descargando Excel tras reintentos");
}

export async function* streamFile(
  url: string,
  delimiter: string = "|",
  maxRetries: number = 3,
  signal?: AbortSignal,
  opts?: StreamOptions
): AsyncGenerator<{ headers: string[]; row: ProductRow; lineNumber: number }> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  if (isLocalFilePath(url)) {
    const content = await fs.readFile(url);
    if (isExcelUrl(url)) {
      yield* streamExcelFromBuffer(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength));
    } else {
      yield* streamCSVFromBuffer(content, delimiter);
    }
    return;
  }

  if (isExcelUrl(url)) {
    yield* streamExcel(url, maxRetries);
  } else {
    yield* streamCSV(url, delimiter, maxRetries, opts);
  }
}

export async function fetchCSVCategories(
  url: string,
  delimiter: string = "|",
  columnName: string = "category"
): Promise<string[]> {
  const categories = new Set<string>();

  for await (const { row } of streamFile(url, delimiter)) {
    const val = (row[columnName] || "").trim();
    if (val) categories.add(val);
  }

  return [...categories].sort();
}

export async function fetchCSVBrands(
  url: string,
  delimiter: string = "|",
  columnName: string = "brand"
): Promise<string[]> {
  const brands = new Set<string>();

  for await (const { row } of streamFile(url, delimiter)) {
    const val = (row[columnName] || "").trim();
    if (val) brands.add(val);
  }

  return [...brands].sort();
}

export async function fetchCSVSkus(
  url: string,
  delimiter: string = "|",
  columnName: string = "sku",
  titleColumn: string = "name",
  search?: string,
  eanColumn?: string
): Promise<Array<{ value: string; label: string }>> {
  const seen = new Map<string, string>();
  const searchLower = search?.toLowerCase();

  let validSkuCol = columnName;
  let validTitleCol = titleColumn;
  let validEanCol = eanColumn || "ean";
  let headersValidated = false;
  let firstRow: ProductRow | null = null;
  let csvHeaders: string[] = [];

  let rowCount = 0;

  for await (const { headers, row } of streamFile(url, delimiter)) {
    if (!headersValidated) {
      headersValidated = true;
      csvHeaders = headers;
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
    if (!firstRow) firstRow = row;
    const sku = (row[validSkuCol] || "").trim();
    if (!sku) continue;
    const name = (row[validTitleCol] || "").trim();
    const ean = validEanCol ? (row[validEanCol] || "").trim() : "";
    rowCount++;
    if (searchLower && !sku.toLowerCase().includes(searchLower) && !name.toLowerCase().includes(searchLower) && !ean.toLowerCase().includes(searchLower)) continue;
    if (!seen.has(sku)) {
      seen.set(sku, name);
    }
  }

  return [...seen.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sku, name]) => ({
      value: sku,
      label: name ? `${sku} — ${name}` : sku,
    }));
}

export async function fetchCSVHeaders(
  url: string,
  delimiter: string = "|",
  maxRetries: number = 3
): Promise<string[]> {
  assertNonEmptyUrl(url);
  const localFile = isLocalFilePath(url) ? url : null;

  if (localFile && isExcelUrl(url)) {
    const content = await fs.readFile(localFile);
    const buffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("El archivo Excel no tiene hojas");

    const sheet = workbook.Sheets[sheetName];
    const rawData: any[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });

    if (rawData.length === 0) return [];

    for (let i = 0; i < Math.min(rawData.length, 30); i++) {
      const r = rawData[i];
      const nonEmpty = r.filter((c: any) => c !== null && c !== undefined && String(c).trim() !== "");
      if (nonEmpty.length >= 3) {
        const candidate = r.map((c: any) => String(c ?? "").trim());
        const hasMeaningful = candidate.some((h: string) =>
          h.length > 1 && !/^\d+$/.test(h) && !/^_empty/i.test(h)
        );
        if (hasMeaningful) {
          return candidate.map((h: string) => h.toLowerCase());
        }
      }
    }

    return rawData[0].map((c: any) => String(c ?? "").trim().toLowerCase());
  }

  if (localFile) {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const content = await fs.readFile(localFile);
        const enc = detectEncoding(content);
        const decoder = new TextDecoder(enc);
        let buffer = decoder.decode(content);

        if (delimiter === "auto" && buffer.includes("\n")) {
          const detected = autoDetectDelimiter(buffer.split("\n").slice(0, 5).join("\n"));
          const newlineIndex = buffer.indexOf("\n");
          const firstLine = buffer.slice(0, newlineIndex).trim();
          return parseCSVLine(firstLine, detected).map((h) => h.toLowerCase());
        }

        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          const firstLine = buffer.slice(0, newlineIndex).trim();
          return parseCSVLine(firstLine, delimiter).map((h) => h.toLowerCase());
        }

        if (buffer.trim()) {
          const effectiveDelim = delimiter === "auto" ? autoDetectDelimiter(buffer) : delimiter;
          return parseCSVLine(buffer.trim(), effectiveDelim).map((h) => h.toLowerCase());
        }

        throw new Error("CSV vacío");
      } catch (error: any) {
        lastError = error;
        if (attempt < maxRetries) {
          const wait = attempt * 2000;
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
    throw lastError || new Error("Error leyendo CSV local tras reintentos");
  }

  let effectiveUrl = url;
  // Normalize Google Drive URLs to bypass viewer/consent page
  if (effectiveUrl.includes("drive.google.com") && effectiveUrl.includes("export=download") && !effectiveUrl.includes("confirm=")) {
    effectiveUrl = `${effectiveUrl}&confirm=t`;
  }
  effectiveUrl = normalizeGoogleSheetsUrl(effectiveUrl);
  if (isExcelUrl(effectiveUrl)) {
    const response = await fetch(effectiveUrl);
    if (!response.ok) throw new Error(googleDownloadError(effectiveUrl, response.status) ?? `Error descargando Excel: ${response.status}`);

    const buffer = await response.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("El archivo Excel no tiene hojas");

    const sheet = workbook.Sheets[sheetName];
    const rawData: any[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });

    if (rawData.length === 0) return [];

    for (let i = 0; i < Math.min(rawData.length, 30); i++) {
      const r = rawData[i];
      const nonEmpty = r.filter((c: any) => c !== null && c !== undefined && String(c).trim() !== "");
      if (nonEmpty.length >= 3) {
        const candidate = r.map((c: any) => String(c ?? "").trim());
        const hasMeaningful = candidate.some((h: string) =>
          h.length > 1 && !/^\d+$/.test(h) && !/^_empty/i.test(h)
        );
        if (hasMeaningful) {
          return candidate.map((h: string) => h.toLowerCase());
        }
      }
    }

    return rawData[0].map((c: any) => String(c ?? "").trim().toLowerCase());
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(effectiveUrl);
      if (!response.ok) {
        throw new Error(googleDownloadError(effectiveUrl, response.status) ?? `Error descargando CSV: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No se pudo leer el stream");

      const firstChunk = await reader.read();
      if (firstChunk.done) throw new Error("CSV vacío");
      const enc = detectEncoding(firstChunk.value);
      const decoder = new TextDecoder(enc);
      let buffer = decoder.decode(firstChunk.value, { stream: true });

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          if (delimiter === "auto" && buffer.includes("\n")) {
            const detected = autoDetectDelimiter(buffer.split("\n").slice(0, 5).join("\n"));
            const newlineIndex = buffer.indexOf("\n");
            const firstLine = buffer.slice(0, newlineIndex).trim();
            return parseCSVLine(firstLine, detected).map((h) => h.toLowerCase());
          }

          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex !== -1) {
            const firstLine = buffer.slice(0, newlineIndex).trim();
            return parseCSVLine(firstLine, delimiter).map((h) => h.toLowerCase());
          }
        }

        if (buffer.trim()) {
          const effectiveDelim = delimiter === "auto" ? autoDetectDelimiter(buffer) : delimiter;
          return parseCSVLine(buffer.trim(), effectiveDelim).map((h) => h.toLowerCase());
        }

        throw new Error("CSV vacío");
      } finally {
        await reader.cancel();
      }
    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries) {
        const wait = attempt * 2000;
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
    throw lastError || new Error("Error descargando CSV tras reintentos");
}

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

function parseCommaList(s?: string | null): string[] {
  if (!s) return [];
  return s.split(",").map((t) => normalize(t)).filter(Boolean);
}

function matchesWildcard(value: string, pattern: string): boolean {
  const v = normalize(value);
  const p = normalize(pattern);
  if (p.endsWith("*")) {
    return v.startsWith(p.slice(0, -1));
  }
  if (p.startsWith("*")) {
    return v.endsWith(p.slice(1));
  }
  return v === p;
}

export interface ExclusionConfig {
  excludeTitleWords?: string | null;
  excludeSkus?: string | null;
  excludeEans?: string | null;
  excludeBrands?: string | null;
}

export function isExcluded(
  row: ProductRow,
  columnMaps: Array<{ shopifyField: string; csvColumn: string | null; defaultValue: string | null }>,
  config: ExclusionConfig,
  getFieldFn: (row: ProductRow, maps: Array<{ shopifyField: string; csvColumn: string | null; defaultValue: string | null }>, field: string) => string | undefined,
  rawValues?: { sku?: string; ean?: string }
): { excluded: boolean; reason?: string } {
  const titleWords = parseCommaList(config.excludeTitleWords);
  const excludeSkus = parseCommaList(config.excludeSkus);
  const excludeEans = parseCommaList(config.excludeEans);

  if (titleWords.length > 0) {
    const title = normalize(getFieldFn(row, columnMaps, "title") || "");
    for (const word of titleWords) {
      if (title.includes(word)) {
        return { excluded: true, reason: `título contiene "${word}"` };
      }
    }
  }

  if (excludeSkus.length > 0) {
    const sku = normalize(
      rawValues?.sku ||
      getFieldFn(row, columnMaps, "sku") ||
      row["sku"] || row["SKU"] || ""
    );
    if (sku) {
      for (const pattern of excludeSkus) {
        if (matchesWildcard(sku, pattern)) {
          return { excluded: true, reason: `SKU "${sku}" coincide con "${pattern}"` };
        }
      }
    }
  }

  if (excludeEans.length > 0) {
    const ean = normalize(
      rawValues?.ean ||
      getFieldFn(row, columnMaps, "ean") ||
      row["ean"] || row["EAN"] || ""
    );
    if (ean) {
      for (const pattern of excludeEans) {
        if (matchesWildcard(ean, pattern)) {
          return { excluded: true, reason: `EAN "${ean}" coincide con "${pattern}"` };
        }
      }
    }
  }

  const excludeBrands = parseCommaList(config.excludeBrands);
  if (excludeBrands.length > 0) {
    const brand = normalize(getFieldFn(row, columnMaps, "brand") || "");
    if (brand) {
      for (const b of excludeBrands) {
        if (brand === b || brand.includes(b)) {
          return { excluded: true, reason: `marca "${brand}" excluida` };
        }
      }
    }
  }

  return { excluded: false };
}

export interface ExcludeFieldRule {
  sku: string;
  skip: string[];
}

export function parseExcludeFieldRules(raw?: string | null): ExcludeFieldRule[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((r: any) => ({
      sku: normalize(String(r.sku || "")),
      skip: Array.isArray(r.skip) ? r.skip : [],
    })).filter((r) => r.sku);
  } catch {
    return [];
  }
}

export function getExcludedFields(
  sku: string,
  rules: ExcludeFieldRule[],
  ean?: string | null
): string[] | null {
  const s = normalize(sku);
  const e = ean ? normalize(ean) : "";
  const rule = rules.find((r) => r.sku === s || (e !== "" && r.sku === e));
  return rule?.skip ?? null;
}
