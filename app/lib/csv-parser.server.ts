export interface ProductRow {
  [key: string]: string | undefined;
}

import * as XLSX from "xlsx";
import fs from "node:fs/promises";
import path from "node:path";

function isLocalFilePath(url: string): boolean {
  return url.startsWith("/") || url.match(/^[A-Z]:\\/i) !== null || url.startsWith("file:");
}

function detectEncoding(buffer: Uint8Array): string {
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return "utf-8";
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
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  };
  const blob = new Blob([content], { type: mimeTypes[ext] || "text/csv" });
  return URL.createObjectURL(blob);
}

export function parseCSVLine(line: string, delimiter: string = "|"): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  line = line.replace(/^\uFEFF/, "");

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
  let bestScore = 0;
  const lines = sample.split("\n").slice(0, 5);

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
    const minCount = Math.min(...counts);
    const maxCount = Math.max(...counts);
    const consistent = maxCount > 0 && maxCount - minCount <= 1;
    if (consistent && maxCount > bestScore) {
      bestScore = maxCount;
      bestDelimiter = d;
    }
  }
  return bestDelimiter;
}

export async function* streamCSV(
  url: string,
  delimiter: string = "|",
  maxRetries: number = 3
): AsyncGenerator<{ headers: string[]; row: ProductRow; lineNumber: number }> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Error descargando CSV: ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No se pudo leer el stream del CSV");

      let buffer = "";
      let headers: string[] = [];
      let lineNumber = 0;
      let incompleteLine = "";
      let effectiveDelimiter = delimiter === "auto" ? null : delimiter;

      const firstChunk = await reader.read();
      if (firstChunk.done) throw new Error("CSV vacío");
      const enc = detectEncoding(firstChunk.value);
      const decoder = new TextDecoder(enc);
      if (enc !== "utf-8") console.log(`[CSV] Encoding detectado: ${enc}`);
      buffer += decoder.decode(firstChunk.value, { stream: true });

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush remaining bytes from the decoder
          const remaining = decoder.decode();
          if (remaining) buffer += remaining;
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        if (!effectiveDelimiter && buffer.length > 0) {
          const sample = buffer.split("\n").slice(0, 5).join("\n");
          if (sample.length > 10 || buffer.includes("\n")) {
            effectiveDelimiter = autoDetectDelimiter(sample);
            console.log(`[CSV] Delimiter auto-detectado: ${JSON.stringify(effectiveDelimiter)}`);
          }
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
            continue;
          }

          const values = parseCSVLine(trimmed, effectiveDelimiter || "|");
          const row: ProductRow = {};

          headers.forEach((header, index) => {
            row[header] = values[index] || "";
          });

          yield { headers, row, lineNumber };
        }
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

      console.log(`[streamCSV] Stream complete: ${lineNumber} lines processed (${lineNumber > 1 ? lineNumber - 1 : 0} data rows)`);
      return; // Success, exit retry loop
    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries) {
        const wait = attempt * 2000;
        console.log(`[streamCSV] Error fetching CSV (attempt ${attempt}/${maxRetries}): ${error?.message}. Retrying in ${wait}ms...`);
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
  if (enc !== "utf-8") console.log(`[CSV] Encoding detectado: ${enc}`);
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
      console.log(`[CSV] Delimiter auto-detectado: ${JSON.stringify(effectiveDelimiter)}`);
    }

    lineNumber++;
    if (lineNumber === 1) {
      headers = parseCSVLine(fullLine.trim(), effectiveDelimiter || "|").map((h) => h.toLowerCase());
      console.log(`[CSV] Headers detectados:`, headers);
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
  console.log(`[CSV] streamCSVFromBuffer total rows yielded: ${lineNumber - 1}`);
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
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Error descargando Excel: ${response.status} ${response.statusText}`);
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
      lastError = error;
      if (attempt < maxRetries) {
        const wait = attempt * 2000;
        console.log(`[streamExcel] Error fetching Excel (attempt ${attempt}/${maxRetries}): ${error?.message}. Retrying in ${wait}ms...`);
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
  signal?: AbortSignal
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
    yield* streamCSV(url, delimiter, maxRetries);
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

  console.log(`[fetchCSVSkus] Total unique SKUs: ${seen.size}`);
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
          console.log(`[fetchCSVHeaders] Error (attempt ${attempt}/${maxRetries}): ${error?.message}. Retrying in ${wait}ms...`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
    throw lastError || new Error("Error leyendo CSV local tras reintentos");
  }

  let effectiveUrl = url;
  if (isExcelUrl(url)) {
    const response = await fetch(effectiveUrl);
    if (!response.ok) throw new Error(`Error descargando Excel: ${response.status}`);

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
        throw new Error(`Error descargando CSV: ${response.status}`);
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
        console.log(`[fetchCSVHeaders] Error (attempt ${attempt}/${maxRetries}): ${error?.message}. Retrying in ${wait}ms...`);
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
  rules: ExcludeFieldRule[]
): string[] | null {
  const s = normalize(sku);
  const rule = rules.find((r) => r.sku === s);
  return rule?.skip ?? null;
}
