import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/lib/db.server";
import { invalidateCache } from "~/lib/csv-cache.server";
import { uploadToStorage, deleteFromStorage, fileExistsInStorage, getFileSize, isBucketKey, makeBucketKey, listStorageFiles } from "~/lib/storage.server";
import fs from "node:fs/promises";
import path from "node:path";

const UPLOAD_BASE = path.join(process.cwd(), "uploads");

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const url = new URL(request.url);
  const configId = url.searchParams.get("configId");

  if (!configId) return data({ error: "configId requerido" }, { status: 400 });

  const config = await prisma.importConfig.findUnique({ where: { id: configId } });
  if (!config || config.shopDomain !== shopDomain) {
    return data({ error: "No encontrado" }, { status: 404 });
  }

  // Always try to list files from bucket prefix when storage is configured
  const bucketFiles = await listStorageFiles(shopDomain, configId);
  if (bucketFiles.length > 0) {
    return data({
      files: bucketFiles.map((f) => ({
        name: f.name,
        originalName: f.name.replace(/^\d+_/, ""),
        size: f.size,
        uploadedAt: f.lastModified,
        fullPath: f.key,
      })).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)),
    });
  }

  // Legacy local disk fallback
  const supplierDir = path.join(UPLOAD_BASE, shopDomain, configId);
  try {
    const files = await fs.readdir(supplierDir);
    const fileDetails = await Promise.all(
      files
        .filter((f) => !f.startsWith("."))
        .map(async (f) => {
          const stat = await fs.stat(path.join(supplierDir, f));
          return {
            name: f,
            originalName: f.replace(/^\d+_/, ""),
            size: stat.size,
            uploadedAt: stat.mtime.toISOString(),
            fullPath: path.join(supplierDir, f),
          };
        })
    );
    return data({ files: fileDetails.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)) });
  } catch {
    return data({ files: [] });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  try {
    const formData = await request.formData();
    const intent = formData.get("intent") as string;

    if (intent === "delete") {
      const configId = formData.get("configId") as string;
      const fileName = formData.get("fileName") as string;
      const fileKey = formData.get("fileKey") as string | null;
      if (!configId || !fileName) return data({ error: "Parámetros requeridos" }, { status: 400 });

      const config = await prisma.importConfig.findUnique({ where: { id: configId } });
      if (!config || config.shopDomain !== shopDomain) {
        return data({ error: "No encontrado" }, { status: 404 });
      }

      // Delete from bucket or local disk
      // Check fileKey first (always present for bucket files), fallback to config.localFilePath
      const keyToDelete = fileKey || config.localFilePath || "";
      if (isBucketKey(keyToDelete)) {
        await deleteFromStorage(keyToDelete);
        // If deleting the active file, clear localFilePath
        if (keyToDelete === config.localFilePath) {
          await prisma.importConfig.update({
            where: { id: configId },
            data: { localFilePath: null, dataSource: "url" },
          });
        }
      } else {
        const filePath = path.join(UPLOAD_BASE, shopDomain, configId, fileName);
        try { await fs.unlink(filePath); } catch {}
      }
      invalidateCache(configId);
      return data({ success: true });
    }

    if (intent === "use") {
      const configId = formData.get("configId") as string;
      const filePath = formData.get("filePath") as string;
      if (!configId || !filePath) return data({ error: "Parámetros requeridos" }, { status: 400 });

      const config = await prisma.importConfig.findUnique({ where: { id: configId } });
      if (!config || config.shopDomain !== shopDomain) {
        return data({ error: "No encontrado" }, { status: 404 });
      }

      let currentPresets: Array<{
        dataSource: string;
        fileName?: string;
        filterType: string;
        filterSkus: string;
        filterCategories: string;
        delimiter: string;
      }> = [];
      try {
        currentPresets = config.filterPresets ? JSON.parse(config.filterPresets) : [];
        if (!Array.isArray(currentPresets)) currentPresets = [];
      } catch { currentPresets = []; }

      const currentFileName = config.localFilePath?.split(/[/\\]/).pop() || undefined;
      const newFileName = filePath.split(/[/\\]/).pop() || undefined;

      const currentDelimiter = config.csvDelimiter || "auto";
      if (config.filterType !== "all" || config.filterSkus || config.filterCategories || currentDelimiter !== "|") {
        const existingIdx = currentPresets.findIndex(
          (p) => p.dataSource === config.dataSource && (p.fileName || undefined) === currentFileName
        );
        const preset = {
          dataSource: config.dataSource,
          fileName: currentFileName,
          filterType: config.filterType,
          filterSkus: config.filterSkus || "",
          filterCategories: config.filterCategories || "",
          delimiter: currentDelimiter,
        };
        if (existingIdx >= 0) {
          currentPresets[existingIdx] = preset;
        } else {
          currentPresets.push(preset);
        }
      }

      const targetPreset = currentPresets.find(
        (p) => p.dataSource === "file" && (p.fileName || undefined) === newFileName
      );

      await prisma.importConfig.update({
        where: { id: configId },
        data: {
          localFilePath: filePath,
          dataSource: "file",
          filterType: targetPreset?.filterType || "all",
          filterSkus: targetPreset?.filterSkus || "",
          filterCategories: targetPreset?.filterCategories || "",
          csvDelimiter: targetPreset?.delimiter || config.csvDelimiter,
          filterPresets: JSON.stringify(currentPresets),
        },
      });
      invalidateCache(configId);
      return data({ success: true });
    }

    // === UPLOAD ===
    const file = formData.get("file") as File | null;
    const configId = formData.get("configId") as string;

    if (!file || !configId) {
      return data({ error: "Archivo y configId requeridos" }, { status: 400 });
    }

    const config = await prisma.importConfig.findUnique({ where: { id: configId } });
    if (!config || config.shopDomain !== shopDomain) {
      return data({ error: "No encontrado" }, { status: 404 });
    }

    const ext = path.extname(file.name).toLowerCase();
    const allowedExts = [".csv", ".xlsx", ".xls", ".ods"];
    if (!allowedExts.includes(ext)) {
      return data({ error: `Formato no soportado: ${ext}. Usar CSV o Excel.` }, { status: 400 });
    }

    if (file.size > 80 * 1024 * 1024) {
      return data({ error: "Archivo demasiado grande (máx 80MB)" }, { status: 400 });
    }

    // Límite de 3 archivos — check existing files in bucket or disk
    if (isBucketKey(config.localFilePath || "")) {
      // Bucket: count files by prefix
      const existingFiles = await listStorageFiles(shopDomain, configId);
      if (existingFiles.length >= 3) {
        return data({ error: "upload.maxFilesPerSupplier", errorIsKey: true }, { status: 400 });
      }
    } else {
      // Legacy disk: check file count
      const supplierDir = path.join(UPLOAD_BASE, shopDomain, configId);
      await fs.mkdir(supplierDir, { recursive: true });
      const existingFiles = (await fs.readdir(supplierDir).catch(() => []))
        .filter((f) => !f.startsWith("."));
      if (existingFiles.length >= 3) {
        return data({ error: "upload.maxFilesPerSupplier", errorIsKey: true }, { status: 400 });
      }
    }

    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileName = `${timestamp}_${safeName}`;

    // Upload to bucket
    const arrayBuffer = await file.arrayBuffer();
    const body = Buffer.from(arrayBuffer);

    let storageKey: string;
    try {
      storageKey = await uploadToStorage(shopDomain, configId, fileName, body, file.type || "text/csv");
    } catch (uploadErr: any) {
      // Fallback to local disk if bucket not configured
      console.warn("[Upload] Bucket upload failed, falling back to local disk:", uploadErr?.message);
      const supplierDir = path.join(UPLOAD_BASE, shopDomain, configId);
      await fs.mkdir(supplierDir, { recursive: true });
      const filePath = path.join(supplierDir, fileName);
      await fs.writeFile(filePath, body);
      storageKey = filePath;
    }

    await prisma.importConfig.update({
      where: { id: configId },
      data: { localFilePath: storageKey, dataSource: "file", filterSkus: "", filterCategories: "", filterType: "all" },
    });

    invalidateCache(configId);

    return data({
      success: true,
      fileName,
      localPath: storageKey,
      originalName: file.name,
      size: file.size,
    });
  } catch (error: any) {
    console.error("[Upload] Error:", error?.message);
    return data({ error: error?.message || "Error subiendo archivo" }, { status: 500 });
  }
};
