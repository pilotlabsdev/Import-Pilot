import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data } from "react-router";

import { useLoaderData, useActionData, Form, useFetcher, useRevalidator } from "react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import fs from "node:fs/promises";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DropZone,
  FormLayout,
  InlineStack,
  Modal,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { NoteIcon } from "@shopify/polaris-icons";
import { prisma, getConfigById } from "~/lib/db.server";
import { isBucketKey, fileExistsInStorage } from "~/lib/storage.server";
import { authenticate, unauthenticated } from "~/shopify.server";
import { refreshSchedules } from "~/lib/scheduler.server";
import { getChannels, getMarkets } from "~/lib/channels.server";
import { invalidateCache } from "~/lib/csv-cache.server";
import { SearchableMultiSelect } from "~/components/SearchableMultiSelect";
import { useTranslation } from "react-i18next";

const UPDATE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "name", label: "config.fieldName" },
  { value: "description", label: "config.fieldDescription" },
  { value: "price", label: "config.fieldPrice" },
  { value: "stock", label: "config.fieldStock" },
  { value: "images", label: "config.fieldImages" },
  { value: "vendor", label: "config.fieldBrand" },
  { value: "productType", label: "config.fieldProductType" },
  { value: "tags", label: "config.fieldTags" },
  { value: "metafields", label: "config.fieldMetafields" },
  { value: "collections", label: "config.fieldCollections" },
];

function parseUpdateOptions(raw?: string | null): string[] {
  try {
    const arr: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return UPDATE_OPTIONS.map((o) => o.value);
    return UPDATE_OPTIONS.map((o) => o.value).filter((v) => arr.includes(v));
  } catch {
    return UPDATE_OPTIONS.map((o) => o.value);
  }
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configId = params.id as string;

  const config = await getConfigById(configId);
  if (!config || config.shopDomain !== shopDomain) throw new Response("Not found", { status: 404 });

  let fileExists = false;
  if (config.localFilePath) {
    if (isBucketKey(config.localFilePath)) {
      fileExists = await fileExistsInStorage(config.localFilePath);
    } else {
      try {
        await fs.access(config.localFilePath);
        fileExists = true;
      } catch {}
    }
  }

  let channels: Array<{ id: string; name: string }> = [];
  let markets: Array<{ id: string; name: string; status: string; publicationId: string | null }> = [];
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    [channels, markets] = await Promise.all([getChannels(admin), getMarkets(admin)]);
  } catch (e: any) {
    console.error("[Config] Error cargando canales/mercados:", e?.message);
  }

  return data({ config, shopDomain, channels, markets, fileExists });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configId = params.id as string;

  const formData = await request.formData();

  const config = await getConfigById(configId);
  if (!config || config.shopDomain !== shopDomain) throw new Response("Not found", { status: 404 });

  const intent = formData.get("intent") as string;

  if (intent === "switch-source") {
    const newDataSource = (formData.get("dataSource") as string) || "url";
    const newLocalFilePath = (formData.get("localFilePath") as string) || null;

    // Guardar filtros actuales en presets antes de cambiar
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
    const newFileName = newLocalFilePath?.split(/[/\\]/).pop() || undefined;

    // Guardar preset de la fuente actual si hay filtros activos o delimiter custom
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

    // Restaurar filtros de la nueva fuente si existe un preset
    const targetPreset = currentPresets.find(
      (p) => p.dataSource === newDataSource && (p.fileName || undefined) === newFileName
    );

    await prisma.importConfig.update({
      where: { id: config.id },
      data: {
        dataSource: newDataSource,
        localFilePath: newLocalFilePath,
        csvUrl: newDataSource === "url" ? (formData.get("csvUrl") as string || config.csvUrl || "") : config.csvUrl,
        filterType: targetPreset?.filterType || "all",
        filterSkus: targetPreset?.filterSkus || "",
        filterCategories: targetPreset?.filterCategories || "",
        csvDelimiter: targetPreset?.delimiter || config.csvDelimiter,
        filterPresets: JSON.stringify(currentPresets),
      },
    });
    invalidateCache(config.id);
    return data({ success: true });
  }

  const newCsvUrl = (formData.get("csvUrl") as string) || config.csvUrl || "";
  const newDataSource = (formData.get("dataSource") as string) || "url";
  const newLocalFilePath = (formData.get("localFilePath") as string) || null;
  const csvUrlChanged = newDataSource === "url" && newCsvUrl !== config.csvUrl;

  const updateData: Record<string, any> = {
    csvUrl: newDataSource === "url" ? newCsvUrl : config.csvUrl,
    dataSource: newDataSource,
    localFilePath: newLocalFilePath,
    csvDelimiter: formData.get("csvDelimiter") as string,
    frequency: (formData.get("frequency") as string) || config.frequency || "12h",
    productStatus: formData.get("productStatus") as string,
    importMode: formData.get("importMode") as string,
    updateOptions: (formData.get("updateOptionsJson") as string) || "[]",
    defaultTags: (formData.get("defaultTags") as string) || null,
    skipZeroStockCreate: formData.get("skipZeroStockCreate") === "true",
    chunkSize: Math.min(Math.max(parseInt((formData.get("chunkSize") as string) || "50"), 1), 250),
    maxRetries: Math.min(Math.max(parseInt((formData.get("maxRetries") as string) || "3"), 0), 10),
    publicationIds: (formData.get("publicationIds") as string) || null,
    marketIds: (formData.get("marketIds") as string) || null,
    excludeTitleWords: (formData.get("excludeTitleWords") as string) || null,
    excludeSkus: (formData.get("excludeSkus") as string) || null,
    excludeEans: (formData.get("excludeEans") as string) || null,
    excludeBrands: (formData.get("excludeBrands") as string) || null,
    excludeFieldRules: (formData.get("excludeFieldRules") as string) || null,
  };

  await prisma.importConfig.update({
    where: { id: config.id },
    data: updateData,
  });

  invalidateCache(config.id);

  if (csvUrlChanged) {
    await prisma.columnMapping.deleteMany({ where: { configId: config.id } });
  }

  await refreshSchedules().catch((error: any) =>
    console.error("[Config] Error refrescando schedulers:", error)
  );

  return data({ success: true });
};

export default function Config() {
  const { config, shopDomain, channels, markets, fileExists } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { success?: boolean } | undefined;
  const fetcher = useFetcher();
  const { revalidate } = useRevalidator();
  const { t } = useTranslation();

  const configId = config.id;

  const [csvUrl, setCsvUrl] = useState(config.csvUrl);
  const [dataSource, setDataSource] = useState<"url" | "file">((config.dataSource as "url" | "file") || "url");
  const [localFilePath, setLocalFilePath] = useState(config.localFilePath || "");
  const [fileSwitched, setFileSwitched] = useState(false);
  const [csvDelimiter, setCsvDelimiter] = useState(config.csvDelimiter);
  const [customDelimiter, setCustomDelimiter] = useState("");
  const [frequency, setFrequency] = useState(config.frequency);
  const [productStatus, setProductStatus] = useState(config.productStatus);
  const [importMode, setImportMode] = useState(config.importMode);
  const [chunkSize, setChunkSize] = useState(String(config.chunkSize));
  const [maxRetries, setMaxRetries] = useState(String(config.maxRetries));
  const [updateOptions, setUpdateOptions] = useState<string[]>(
    parseUpdateOptions(config.updateOptions)
  );
  const [skipZeroStock, setSkipZeroStock] = useState(config.skipZeroStockCreate ?? false);
  const [defaultTags, setDefaultTags] = useState(config.defaultTags || "");
  const [excludeTitleWords, setExcludeTitleWords] = useState(config.excludeTitleWords || "");
  const [excludeSkus, setExcludeSkus] = useState(config.excludeSkus || "");
  const [excludeEans, setExcludeEans] = useState(config.excludeEans || "");
  const [excludeBrands, setExcludeBrands] = useState<string[]>(() => {
    return config.excludeBrands ? config.excludeBrands.split(",").filter(Boolean) : [];
  });
  const [excludeFieldRules, setExcludeFieldRules] = useState<Array<{ sku: string; skip: string[] }>>(() => {
    try { return config.excludeFieldRules ? JSON.parse(config.excludeFieldRules) : []; } catch { return []; }
  });
  const [brandOptions, setBrandOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [loadingBrands, setLoadingBrands] = useState(false);
  const [brandTotal, setBrandTotal] = useState(0);
  const [brandOffset, setBrandOffset] = useState(0);
  const [locations, setLocations] = useState<Array<{ id: string; name: string; isActive: boolean }>>([]);
  const shopify = useAppBridge();
  const formRef = useRef<HTMLFormElement>(null);
  const [selectedLocationId, setSelectedLocationId] = useState(config.locationId || "");
  const [selectedLocationName, setSelectedLocationName] = useState(config.locationName || "");
  const [loadingLocations, setLoadingLocations] = useState(true);
  const [savingLocation, setSavingLocation] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<Array<{ name: string; originalName: string; size: number; uploadedAt: string; fullPath: string }>>([]);

  const [isDirty, setIsDirty] = useState(false);
  const [deleteConfirmFile, setDeleteConfirmFile] = useState<{ name: string; fullPath: string } | null>(null);

  const markDirty = useCallback(() => setIsDirty(true), []);
  const SAVE_BAR_ID = "config-save-bar";

  useEffect(() => {
    if (isDirty) shopify.saveBar.show(SAVE_BAR_ID);
    else shopify.saveBar.hide(SAVE_BAR_ID);
  }, [isDirty, shopify]);

  const restoreAllState = useCallback((cfg: typeof config) => {
    setCsvUrl(cfg.csvUrl);
    setDataSource((cfg.dataSource as "url" | "file") || "url");
    setLocalFilePath(cfg.localFilePath || "");
    setCsvDelimiter(cfg.csvDelimiter);
    setFrequency(cfg.frequency);
    setProductStatus(cfg.productStatus);
    setImportMode(cfg.importMode);
    setChunkSize(String(cfg.chunkSize));
    setMaxRetries(String(cfg.maxRetries));
    setUpdateOptions(parseUpdateOptions(cfg.updateOptions));
    setSkipZeroStock(cfg.skipZeroStockCreate ?? false);
    setDefaultTags(cfg.defaultTags || "");
    setSelectedPublications(parseIds(cfg.publicationIds));
    setExcludeTitleWords(cfg.excludeTitleWords || "");
    setExcludeSkus(cfg.excludeSkus || "");
    setExcludeEans(cfg.excludeEans || "");
    setExcludeBrands(cfg.excludeBrands ? cfg.excludeBrands.split(",").filter(Boolean) : []);
    try { setExcludeFieldRules(cfg.excludeFieldRules ? JSON.parse(cfg.excludeFieldRules) : []); } catch { setExcludeFieldRules([]); }
  }, []);

  const handleDiscard = useCallback(() => {
    restoreAllState(config);
    setIsDirty(false);
  }, [config, restoreAllState]);

  const handleSave = useCallback(() => {
    formRef.current?.requestSubmit();
    setIsDirty(false);
  }, []);

  const isFileSource = dataSource === "file";

  const fetchUploadedFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/upload?configId=${configId}`);
      const d = await res.json();
      setUploadedFiles(d.files || []);
    } catch {}
  }, [configId]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      fetchUploadedFiles();
    }
  }, [fetcher.state, fetcher.data, fetchUploadedFiles]);

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("configId", configId);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const d = await res.json();
      if (d.success && d.localPath) {
        setLocalFilePath(d.localPath);
        setDataSource("file");
        setFileSwitched(true);
        fetchUploadedFiles();
        revalidate();
      } else if (d.error) {
        setUploadError(d.errorIsKey ? t(d.error) : d.error);
      }
    } catch {} finally {
      setUploading(false);
    }
  }, [configId, fetchUploadedFiles]);

  const handleDropZoneDrop = useCallback((_dropFiles: File[], acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      handleUpload(acceptedFiles[0]);
    }
  }, [handleUpload]);

  useEffect(() => { fetchUploadedFiles(); }, [fetchUploadedFiles]);

  useEffect(() => {
    if (actionData?.success) setFileSwitched(false);
  }, [actionData?.success]);

  const parseIds = (raw?: string | null): string[] => {
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
  };
  const [selectedPublications, setSelectedPublications] = useState<string[]>(parseIds(config.publicationIds));
  const validMarketPubIds = new Set(markets.map((m) => m.publicationId).filter(Boolean));
  const [selectedMarkets, setSelectedMarkets] = useState<string[]>(
    parseIds(config.marketIds).filter((id) => validMarketPubIds.has(id))
  );

  const fetchLocations = useCallback(async () => {
    setLoadingLocations(true);
    try {
      const res = await fetch(`/api/locations?shop=${shopDomain}`);
      const d = await res.json();
      setLocations(d.locations || []);
      if (d.selectedId && !selectedLocationId) {
        setSelectedLocationId(d.selectedId);
        setSelectedLocationName(d.selectedName || "");
      }
    } catch {} finally {
      setLoadingLocations(false);
    }
  }, [shopDomain, selectedLocationId]);

  useEffect(() => { fetchLocations(); }, []);

  const fetchBrandOptions = useCallback((q: string, append = false) => {
    const timer = setTimeout(async () => {
      setLoadingBrands(true);
      try {
        const params = new URLSearchParams({ shop: shopDomain, type: "brand", limit: "200", configId });
        if (q) params.set("q", q);
        if (append && brandOffset > 0) params.set("offset", String(brandOffset));
        if (excludeBrands.length > 0) params.set("selected", excludeBrands.join(","));
        const res = await fetch(`/api/csv-options?${params}`);
        const d = await res.json();
        if (append) {
          setBrandOptions((prev) => [...prev, ...(d.options || [])]);
        } else {
          setBrandOptions(d.options || []);
          setBrandOffset(0);
        }
        setBrandTotal(d.total || 0);
        setBrandOffset((append ? brandOffset : 0) + (d.options?.length || 0));
      } catch { if (!append) setBrandOptions([]); }
      finally { setLoadingBrands(false); }
    }, 300);
    return () => clearTimeout(timer);
  }, [shopDomain, brandOffset, excludeBrands]);

  useEffect(() => { if (importMode === "bulk" || true) { setBrandOffset(0); fetchBrandOptions(""); } }, []);

  const saveLocation = async (locId: string, locName: string) => {
    setSavingLocation(true);
    try {
      const formData = new FormData();
      formData.set("shop", shopDomain);
      formData.set("configId", configId);
      formData.set("locationId", locId);
      formData.set("locationName", locName);
      await fetch("/api/locations", { method: "POST", body: formData });
    } finally {
      setSavingLocation(false);
    }
  };

  const toggleUpdateOption = (value: string) => {
    setUpdateOptions((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    );
    markDirty();
  };

  const delimiterOptions = [
    { label: t("config.autoDetect"), value: "auto" },
    { label: t("config.pipe"), value: "|" },
    { label: t("config.comma"), value: "," },
    { label: t("config.semicolon"), value: ";" },
    { label: t("config.tab"), value: "\t" },
    { label: t("config.custom"), value: "__custom__" },
  ];

  const frequencyOptions = [
    { label: t("frequency.every30min"), value: "30min" },
    { label: t("frequency.hourly"), value: "hourly" },
    { label: t("frequency.every2h"), value: "2h" },
    { label: t("frequency.every3h"), value: "3h" },
    { label: t("frequency.every4h"), value: "4h" },
    { label: t("frequency.every6h"), value: "6h" },
    { label: t("frequency.every12h"), value: "12h" },
    { label: t("frequency.daily"), value: "daily" },
    { label: t("frequency.weekly"), value: "weekly" },
  ];

  const productStatusOptions = [
    { label: t("common.draft"), value: "DRAFT" },
    { label: t("common.active"), value: "ACTIVE" },
  ];

  const importModeOptions = [
    { label: t("common.chunks"), value: "chunks" },
    ...(isFileSource
      ? [{ label: t("config.bulkOnlyUrl"), value: "bulk" }]
      : [{ label: t("common.bulkOperation"), value: "bulk" }]
    ),
  ];

  return (
    <>
      {actionData?.success && (
        <Banner tone="success" title={t("import.saved")} />
      )}

      {fileSwitched && csvUrl !== config.csvUrl && (
        <Banner tone="warning" title={t("import.fileChanged")}>
          {t("import.fileChangedMessage")}
        </Banner>
      )}

      {importMode === "bulk" && (
        <Banner tone="info" title={t("import.bulkModeInfo")}>
          {t("import.bulkModeMessage")}
        </Banner>
      )}

      <Form ref={formRef} method="post">
        <SaveBar id={SAVE_BAR_ID}>
          <button variant="primary" type="button" onClick={handleSave}>{t("common.save")}</button>
          <button type="button" onClick={handleDiscard}>{t("common.discard")}</button>
        </SaveBar>
        <FormLayout>
          <div data-tutorial="datasource-card">
          <Card>
            <FormLayout>
              <input type="hidden" name="dataSource" value={dataSource} />
              <input type="hidden" name="localFilePath" value={localFilePath} />

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">{t("config.dataSource")}</Text>
                <div data-tutorial="url-toggle">
                <InlineStack gap="200">
                  <Button
                    size="slim"
                    variant={dataSource === "url" ? "primary" : "secondary"}
                    onClick={() => setDataSource("url")}
                  >
                    {t("config.remoteUrl")}
                  </Button>
                   <span data-tutorial="file-toggle">
                   <Button
                    size="slim"
                    variant={dataSource === "file" ? "primary" : "secondary"}
                    onClick={() => setDataSource("file")}
                  >
                     {t("config.uploadedFile")}
                  </Button>
                   </span>
                </InlineStack>
                </div>
              </BlockStack>

              {dataSource === "url" ? (
                <BlockStack gap="200">
                  <TextField
                    type="text"
                    name="csvUrl"
                    label={t("config.urlLabel")}
                    value={csvUrl}
                    onChange={(v) => { setCsvUrl(v); markDirty(); }}
                    autoComplete="off"
                    helpText={t("config.urlHelp")}
                  />
                  <InlineStack gap="200" blockAlign="center">
                    <Button
                      size="slim"
                      variant="primary"
                      onClick={() => {
                        setDataSource("url");
                        setLocalFilePath("");
                        setFileSwitched(true);
                        fetcher.submit(
                          { intent: "switch-source", dataSource: "url", localFilePath: "", csvUrl },
                          { method: "POST" }
                        );
                      }}
                    >
                      {t("config.useUrl")}
                    </Button>
                    {dataSource === "url" && !localFilePath && csvUrl && <Badge tone="success">{t("config.urlActive")}</Badge>}
                    {dataSource === "url" && localFilePath && <Badge tone="warning">{t("config.fileSelected")}</Badge>}
                  </InlineStack>
                </BlockStack>
              ) : (
                <BlockStack gap="200">
                  {localFilePath ? (
                    fileExists ? (
                      <Badge tone="success">{t("config.fileActive", { filename: localFilePath.split(/[/\\]/).pop() || localFilePath })}</Badge>
                    ) : (
                      <Banner tone="warning">
                        <p>{t("config.fileMissing", { filename: localFilePath.split(/[/\\]/).pop() || localFilePath })}</p>
                      </Banner>
                    )
                  ) : (
                    <Badge tone="info">{t("config.noFileSelected")}</Badge>
                  )}
                  {csvUrl && !localFilePath && <Badge tone="warning">{t("config.urlConfigured")}</Badge>}
                  <DropZone
                    onDrop={handleDropZoneDrop}
                    accept=".csv,.xlsx,.xls,.ods"
                    type="file"
                    outline={false}
                  >
                    <DropZone.FileUpload
                      actionTitle={t("config.uploadFile")}
                      actionHint={t("config.fileTypes")}
                    />
                  </DropZone>
                  {uploading && (
                    <InlineStack gap="200" blockAlign="center">
                      <Spinner size="small" />
                      <Text as="p" variant="bodySm">{t("config.uploading")}</Text>
                    </InlineStack>
                  )}
                  {uploadError && (
                    <Banner tone="critical">
                      <p>{uploadError}</p>
                    </Banner>
                  )}
                  {uploadedFiles.length > 0 && (
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">
                        {t("config.uploadedFiles")}
                      </Text>
                      {uploadedFiles.map((f) => {
                        const isActive = localFilePath === f.fullPath;
                        return (
                          <InlineStack key={f.name} align="space-between" blockAlign="center">
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="p" variant="bodySm" fontWeight={isActive ? "semibold" : undefined}>
                                {f.originalName} ({(f.size / 1024).toFixed(0)} KB)
                              </Text>
                              {isActive && <Badge tone="success">{t("config.inUse")}</Badge>}
                            </InlineStack>
                            <InlineStack gap="100">
                              {!isActive && (
                                <Button
                                  size="slim"
                                  onClick={() => {
                                    fetcher.submit(
                                      { intent: "use", configId, filePath: f.fullPath },
                                      { method: "POST", action: "/api/upload" }
                                    );
                                    setLocalFilePath(f.fullPath);
                                    setDataSource("file");
                                    setFileSwitched(true);
                                  }}
                                >
                                  {t("config.use")}
                                </Button>
                              )}
                              <Button
                                size="slim"
                                tone="critical"
                                disabled={isActive}
                                onClick={() => setDeleteConfirmFile({ name: f.name, fullPath: f.fullPath })}
                              >
                                {t("common.delete")}
                              </Button>
                            </InlineStack>
                          </InlineStack>
                        );
                      })}
                    </BlockStack>
                  )}
                </BlockStack>
              )}
            </FormLayout>
          </Card>

          <Card>
            <FormLayout>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
                <div data-tutorial="delimiter-select">
                  <input type="hidden" name="csvDelimiter" value={csvDelimiter === "__custom__" ? customDelimiter : csvDelimiter} />
                  <Select
                    label={t("config.delimiter")}
                    value={csvDelimiter}
                    onChange={(v) => { setCsvDelimiter(v); markDirty(); }}
                    options={delimiterOptions}
                  />
                  {csvDelimiter === "__custom__" && (
                    <div style={{ marginTop: "8px" }}>
                      <TextField
                        label={t("config.customValue")}
                        value={customDelimiter}
                        onChange={(v) => { setCustomDelimiter(v); markDirty(); }}
                        autoComplete="off"
                        placeholder={t("config.customPlaceholder")}
                      />
                    </div>
                  )}
                </div>
                <div data-tutorial="frequency-select">
                <Select
                  name="frequency"
                  label={t("config.frequency")}
                  value={frequency}
                  onChange={(v) => { setFrequency(v); markDirty(); }}
                  disabled={!!isFileSource}
                  helpText={isFileSource ? t("config.frequencyHelp") : undefined}
                  options={frequencyOptions}
                />
                </div>
                <div data-tutorial="product-status-select">
                <Select
                  name="productStatus"
                  label={t("config.productStatus")}
                  value={productStatus}
                  onChange={(v) => { setProductStatus(v); markDirty(); }}
                  options={productStatusOptions}
                />
                </div>
                <input type="hidden" name="importMode" value={isFileSource ? "chunks" : importMode} />
                <div data-tutorial="import-mode-select">
                <Select
                  label={t("config.importMode")}
                  value={isFileSource ? "chunks" : importMode}
                  onChange={(v) => { setImportMode(v); markDirty(); }}
                  disabled={!!isFileSource}
                  helpText={
                    importMode === "bulk"
                      ? t("config.bulkDescription")
                      : t("config.chunksDescription")
                  }
                  options={importModeOptions}
                />
                </div>
                <TextField
                  type="number"
                  name="chunkSize"
                  label={t("config.batchSize")}
                  value={chunkSize}
                  onChange={(val) => {
                    const n = parseInt(val) || 50;
                    setChunkSize(String(Math.min(Math.max(n, 1), 250)));
                    markDirty();
                  }}
                  autoComplete="off"
                  helpText={isFileSource ? t("config.batchSizeHelp") : t("config.maxBatch")}
                  disabled={importMode === "bulk" || !!isFileSource}
                />
                <TextField
                  type="number"
                  name="maxRetries"
                  label={t("config.retries")}
                  value={maxRetries}
                  onChange={(val) => {
                    const n = parseInt(val) || 3;
                    setMaxRetries(String(Math.min(Math.max(n, 0), 10)));
                    markDirty();
                  }}
                  autoComplete="off"
                  helpText={t("config.maxRetries")}
                  disabled={importMode === "bulk" || !!isFileSource}
                />
              </div>

              {isFileSource && (
                <Banner tone="info" title={t("config.manualImport")}>
                  {t("config.manualImportHelp")}
                </Banner>
              )}

              <div data-tutorial="update-options">
                <Checkbox
                  label={t("config.updateFields")}
                  checked={updateOptions.length === UPDATE_OPTIONS.length}
                  onChange={(checked) => {
                    setUpdateOptions(
                      checked ? UPDATE_OPTIONS.map((o) => o.value) : []
                    );
                    markDirty();
                  }}
                  helpText={t("config.updateFieldsHelp")}
                />

                <FormLayout.Group>
                  {UPDATE_OPTIONS.map((option) => (
                    <Checkbox
                      key={option.value}
                      label={t(option.label)}
                      checked={updateOptions.includes(option.value)}
                      onChange={() => toggleUpdateOption(option.value)}
                    />
                  ))}
                </FormLayout.Group>
              </div>

              <input
                type="hidden"
                name="updateOptionsJson"
                value={JSON.stringify(updateOptions)}
              />

              <div data-tutorial="default-tags">
              <TextField
                type="text"
                name="defaultTags"
                label={t("config.defaultTags")}
                value={defaultTags}
                onChange={(v) => { setDefaultTags(v); markDirty(); }}
                autoComplete="off"
                helpText={t("config.defaultTagsHelp")}
              />
              </div>

              <div data-tutorial="channels">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  {t("config.salesChannels")}
                </Text>
                <Text as="p" tone="subdued">
                  {t("config.salesChannelsHelp")}
                </Text>
                {channels.length === 0 ? (
                  <Text as="p" tone="subdued">{t("config.noChannels")}</Text>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px" }}>
                    {channels.map((ch) => (
                      <Checkbox
                        key={ch.id}
                        label={ch.name}
                        checked={selectedPublications.includes(ch.id)}
                        onChange={() => {
                          setSelectedPublications((prev) =>
                            prev.includes(ch.id) ? prev.filter((id) => id !== ch.id) : [...prev, ch.id]
                          );
                          markDirty();
                        }}
                      />
                    ))}
                  </div>
                )}
                <input type="hidden" name="publicationIds" value={JSON.stringify(selectedPublications)} />
              </BlockStack>
              </div>

              {/* Mercados ocultos: Shopify publica automáticamente en todos los mercados/catalogos al crear.
                  Habilitar de nuevo si Shopify permite publicación selectiva por mercado en el futuro. */}
              <input type="hidden" name="marketIds" value="[]" />

              <Checkbox
                label={t("config.noStockZero")}
                checked={skipZeroStock}
                onChange={(v) => { setSkipZeroStock(v); markDirty(); }}
              />
              <input type="hidden" name="skipZeroStockCreate" value={skipZeroStock ? "true" : "false"} />
            </FormLayout>
          </Card>
          </div>

          <div data-tutorial="exclusions-card">
          <Card>
            <FormLayout>
              <Text as="h2" variant="headingMd">{t("config.exclusions")}</Text>
              <Text as="p" tone="subdued">
                {t("config.exclusionsHelp")}
              </Text>

              <TextField
                type="text"
                name="excludeTitleWords"
                label={t("config.excludeTitle")}
                value={excludeTitleWords}
                onChange={(v) => { setExcludeTitleWords(v); markDirty(); }}
                autoComplete="off"
                helpText={t("config.excludeTitleHelp")}
              />

              <FormLayout.Group>
                <TextField
                  type="text"
                  name="excludeSkus"
                  label={t("config.excludeSku")}
                  value={excludeSkus}
                  onChange={(v) => { setExcludeSkus(v); markDirty(); }}
                  autoComplete="off"
                  helpText={t("config.excludeSkuHelp")}
                />
                <TextField
                  type="text"
                  name="excludeEans"
                  label={t("config.excludeEan")}
                  value={excludeEans}
                  onChange={(v) => { setExcludeEans(v); markDirty(); }}
                  autoComplete="off"
                  helpText={t("config.excludeEanHelp")}
                />
              </FormLayout.Group>

              <input type="hidden" name="excludeBrands" value={excludeBrands.join(",")} />
              <InlineStack gap="200" blockAlign="end">
                <div style={{ flex: 1 }}>
                  <SearchableMultiSelect
                    label={t("config.excludeBrand")}
                    options={brandOptions}
                    selected={excludeBrands}
                    onToggle={(val) => { setExcludeBrands((prev) => prev.includes(val) ? prev.filter((v) => v !== val) : [...prev, val]); markDirty(); }}
                    loading={loadingBrands}
                    onSearch={(q) => { setBrandOffset(0); fetchBrandOptions(q); }}
                    onLoadMore={() => fetchBrandOptions("", true)}
                    hasMore={brandOffset < brandTotal}
                    placeholder={t("config.excludeBrandSearch")}
                  />
                </div>
                {excludeBrands.length > 0 && (
                  <Button
                    variant="tertiary"
                    tone="critical"
                    onClick={() => { setExcludeBrands([]); markDirty(); }}
                  >
                    {t("config.clearAll")}
                  </Button>
                )}
              </InlineStack>

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  {t("config.excludeFieldRules")}
                </Text>
                <Text as="p" tone="subdued">
                  {t("config.excludeFieldRulesHelp")}
                </Text>

                {excludeFieldRules.map((rule, idx) => (
                  <InlineStack key={idx} gap="200" blockAlign="end">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label={t("config.excludeSkuField")}
                        value={rule.sku}
                        onChange={(val) => {
                          const updated = [...excludeFieldRules];
                          updated[idx] = { ...updated[idx], sku: val };
                          setExcludeFieldRules(updated);
                          markDirty();
                        }}
                        autoComplete="off"
                      />
                    </div>
                    <Checkbox
                      label={t("config.excludePrice")}
                      checked={rule.skip.includes("price")}
                      onChange={() => {
                        const updated = [...excludeFieldRules];
                        const skip = updated[idx].skip.includes("price")
                          ? updated[idx].skip.filter((s: string) => s !== "price")
                          : [...updated[idx].skip, "price"];
                        updated[idx] = { ...updated[idx], skip };
                        setExcludeFieldRules(updated);
                        markDirty();
                      }}
                    />
                    <Checkbox
                      label={t("config.excludeStock")}
                      checked={rule.skip.includes("stock")}
                      onChange={() => {
                        const updated = [...excludeFieldRules];
                        const skip = updated[idx].skip.includes("stock")
                          ? updated[idx].skip.filter((s: string) => s !== "stock")
                          : [...updated[idx].skip, "stock"];
                        updated[idx] = { ...updated[idx], skip };
                        setExcludeFieldRules(updated);
                        markDirty();
                      }}
                    />
                    <Button
                      tone="critical"
                      onClick={() => {
                        setExcludeFieldRules(excludeFieldRules.filter((_, i) => i !== idx));
                        markDirty();
                      }}
                    >
                      {t("common.delete")}
                    </Button>
                  </InlineStack>
                ))}

                <Button
                  onClick={() => {
                    setExcludeFieldRules([...excludeFieldRules, { sku: "", skip: ["price", "stock"] }]);
                    markDirty();
                  }}
                >
                  {t("config.addSkuRule")}
                </Button>
                <input
                  type="hidden"
                  name="excludeFieldRules"
                  value={JSON.stringify(excludeFieldRules)}
                />
              </BlockStack>
            </FormLayout>
          </Card>
          </div>

          {/* Botón "Guardar" oculto — el SaveBar programático (Guardar/Descartar) lo reemplaza.
              Descomentar si se necesita restaurar el botón clásico: */}
          {/*
          <Button submit variant="primary">
            Guardar Configuración
          </Button>
          */}
        </FormLayout>
      </Form>

          <div data-tutorial="location-select">
          <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">{t("config.inventoryLocation")}</Text>
          <Text as="p" tone="subdued">
            {t("config.inventoryLocationHelp")}
          </Text>
          {loadingLocations ? (
            <InlineStack gap="200" blockAlign="center">
              <Spinner size="small" />
              <Text as="p">{t("config.loadingLocations")}</Text>
            </InlineStack>
          ) : (
            <InlineStack gap="300" blockAlign="end">
              <div style={{ flex: 1 }}>
                <Select
                  label={t("config.location")}
                  options={[
                    ...locations.map((l) => ({
                      label: `${l.name}${l.isActive ? "" : " " + t("config.inactiveLocation")}`,
                      value: l.id,
                    })),
                  ]}
                  value={selectedLocationId || locations[0]?.id || ""}
                  onChange={(val) => {
                    setSelectedLocationId(val);
                    const loc = locations.find((l) => l.id === val);
                    const locName = loc?.name || "";
                    setSelectedLocationName(locName);
                    saveLocation(val, locName);
                  }}
                />
              </div>
              {savingLocation && (
                <InlineStack gap="100" blockAlign="center">
                  <Spinner size="small" />
                  <Text as="p" variant="bodySm">{t("import.saving")}</Text>
                </InlineStack>
              )}
            </InlineStack>
          )}
          {selectedLocationName && (
            <Badge tone="success">{t("config.currentLocation", { name: selectedLocationName })}</Badge>
          )}
          {!selectedLocationName && !selectedLocationId && (
            <Badge tone="info">{t("config.usingDefault")}</Badge>
          )}
        </BlockStack>
      </Card>
      </div>

      <Text as="p" tone="subdued">
        {t("config.storeDomain", { shopDomain })}
      </Text>

      <Modal
        open={!!deleteConfirmFile}
        onClose={() => setDeleteConfirmFile(null)}
        title={t("config.deleteFileConfirmTitle")}
        primaryAction={{
          content: t("common.delete"),
          destructive: true,
          onAction: () => {
            if (!deleteConfirmFile) return;
            fetcher.submit(
              { intent: "delete", configId, fileName: deleteConfirmFile.name, fileKey: deleteConfirmFile.fullPath },
              { method: "POST", action: "/api/upload" }
            );
            if (localFilePath === deleteConfirmFile.fullPath) {
              setLocalFilePath("");
              setDataSource("url");
              setFileSwitched(true);
            }
            setUploadError(null);
            setDeleteConfirmFile(null);
          },
        }}
        secondaryActions={[
          {
            content: t("common.cancel"),
            onAction: () => setDeleteConfirmFile(null),
          },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            {t("config.deleteFileConfirmMessage", { fileName: deleteConfirmFile?.name })}
          </Text>
        </Modal.Section>
      </Modal>
    </>
  );
}
