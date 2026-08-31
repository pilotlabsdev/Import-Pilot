import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data, useLoaderData, useFetcher, useRevalidator, useNavigate } from "react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  Divider,
  FormLayout,
  InlineStack,
  Layout,
  Text,
} from "@shopify/polaris";
import { authenticate, unauthenticated } from "~/shopify.server";
import { prisma, getConfigById } from "~/lib/db.server";
import { SearchableMultiSelect } from "~/components/SearchableMultiSelect";
import { refreshSchedules } from "~/lib/scheduler.server";
import { useTranslation } from "react-i18next";

const STATUS_TONE: Record<string, "success" | "critical" | "attention" | "info"> = {
  completed: "success",
  completed_with_errors: "attention",
  failed: "critical",
  running: "attention",
  scheduled: "info",
};

const FREQUENCY_KEYS: Record<string, string> = {
  "30min": "frequency.every30min",
  hourly: "frequency.hourly",
  "2h": "frequency.every2h",
  "3h": "frequency.every3h",
  "4h": "frequency.every4h",
  "6h": "frequency.every6h",
  "12h": "frequency.every12h",
  daily: "frequency.daily",
  weekly: "frequency.weekly",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configId = params.id as string;

  const fullConfig = await prisma.importConfig.findUnique({
    where: { id: configId },
    select: {
      id: true, shopDomain: true, isActive: true, importMode: true,
      frequency: true, csvUrl: true, dataSource: true, planPaused: true,
    },
  });
  if (!fullConfig || fullConfig.shopDomain !== shopDomain) throw new Response("Not found", { status: 404 });

  const [productCount, lastLog, recentLogs, savedFilter] = await Promise.all([
    prisma.productMapping.count({ where: { configId } }),
    prisma.importLog.findFirst({
      where: { configId },
      orderBy: { startedAt: "desc" },
      select: {
        startedAt: true, status: true, totalProducts: true, created: true,
        updated: true, unchanged: true, errors: true, excludedCount: true, lastSku: true,
      },
    }),
    prisma.importLog.findMany({
      where: { configId },
      orderBy: { startedAt: "desc" },
      take: 10,
      select: {
        startedAt: true, status: true, totalProducts: true, created: true,
        updated: true, unchanged: true, errors: true, excludedCount: true,
      },
    }),
    prisma.importConfig.findUnique({
      where: { id: configId },
      select: { filterType: true, filterSkus: true, filterCategories: true },
    }),
  ]);

  const lastErrors = lastLog?.errors ? (JSON.parse(lastLog.errors) as any[]).length : 0;

  const unresolvedDuplicates = await prisma.duplicateLog.count({
    where: { shopDomain, resolved: false },
  });

  return data({
    config: fullConfig,
    lastLog,
    lastErrors,
    totalProducts: productCount,
    recentLogs,
    savedFilter,
    shopDomain,
    configId,
    unresolvedDuplicates,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configId = params.id as string;
  const form = await request.formData();
  const intent = form.get("intent");

  const config = await getConfigById(configId);
  if (!config || config.shopDomain !== shopDomain) throw new Response("Not found", { status: 404 });

  if (intent === "toggle-active") {
    const newIsActive = !config.isActive;
    await prisma.importConfig.update({
      where: { id: configId },
      data: { isActive: newIsActive },
    });
    await refreshSchedules().catch(() => {});
    return data({ success: true, isActive: newIsActive });
  }

  return data({ error: "supplier.invalidAttempt" });
};

export default function ImportTab() {
  const { t } = useTranslation();
  const { config, lastLog, lastErrors, totalProducts, recentLogs, savedFilter, shopDomain, configId, unresolvedDuplicates } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const filterFetcher = useFetcher();
  const { revalidate } = useRevalidator();
  const navigate = useNavigate();
  const isRunning = fetcher.state !== "idle";

  const [filterBySku, setFilterBySku] = useState(false);
  const [filterByCategory, setFilterByCategory] = useState(false);
  const [selectedSkus, setSelectedSkus] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [skuOptions, setSkuOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [catOptions, setCatOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [loadingSku, setLoadingSku] = useState(false);
  const [loadingCat, setLoadingCat] = useState(false);
  const [skuTotal, setSkuTotal] = useState(0);
  const [skuOffset, setSkuOffset] = useState(0);
  const [catTotal, setCatTotal] = useState(0);
  const [catOffset, setCatOffset] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const filterFormRef = useRef<HTMLFormElement>(null);
  const [filterDirty, setFilterDirty] = useState(false);
  const [schedulerActive, setSchedulerActive] = useState(config?.isActive ?? false);
  const [importActive, setImportActive] = useState(false);
  const shopify = useAppBridge();
  const FILTER_SAVE_BAR_ID = "filter-save-bar";

  useEffect(() => {
    if (filterDirty) shopify.saveBar.show(FILTER_SAVE_BAR_ID);
    else shopify.saveBar.hide(FILTER_SAVE_BAR_ID);
  }, [filterDirty, shopify]);

  // Poll import status every 5s
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/import-status?configId=${configId}`);
        const json = await res.json();
        if (active) setImportActive(json.active);
      } catch {
        if (active) setImportActive(false);
      }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [configId]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      revalidate();
    }
  }, [fetcher.state, fetcher.data, revalidate]);

  useEffect(() => {
    setSchedulerActive(config?.isActive ?? false);
  }, [config?.isActive]);

  const toggleScheduler = () => {
    const newActive = !schedulerActive;
    setSchedulerActive(newActive);
    fetcher.submit(
      { intent: "toggle-active" },
      { method: "POST" }
    );
  };

  useEffect(() => {
    if (!savedFilter) return;
    const hasSkus = !!(savedFilter.filterSkus && savedFilter.filterSkus.trim());
    const hasCats = !!(savedFilter.filterCategories && savedFilter.filterCategories.trim());
    setFilterBySku(hasSkus || savedFilter.filterType === "skus");
    setFilterByCategory(hasCats || savedFilter.filterType === "categories");
    if (savedFilter.filterSkus) setSelectedSkus(savedFilter.filterSkus.split(",").filter(Boolean));
    if (savedFilter.filterCategories) setSelectedCategories(savedFilter.filterCategories.split(",").filter(Boolean));
    setInitialFilter({
      skus: savedFilter.filterSkus || "",
      categories: savedFilter.filterCategories || "",
    });
  }, []);

  const fetchSkuOptions = useCallback((q: string, append = false) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoadingSku(true);
      try {
        const params = new URLSearchParams({ shop: shopDomain, type: "sku", limit: "200", configId });
        if (q) params.set("q", q);
        if (append && skuOffset > 0) params.set("offset", String(skuOffset));
        if (selectedSkus.length > 0) params.set("selected", selectedSkus.join(","));
        const res = await fetch(`/api/csv-options?${params}`);
        const d = await res.json();
        if (append) {
          setSkuOptions((prev) => [...prev, ...(d.options || [])]);
        } else {
          setSkuOptions(d.options || []);
          setSkuOffset(0);
        }
        setSkuTotal(d.total || 0);
        setSkuOffset((append ? skuOffset : 0) + (d.options?.length || 0));
      } catch { if (!append) setSkuOptions([]); }
      finally { setLoadingSku(false); }
    }, 300);
  }, [shopDomain, configId, skuOffset, selectedSkus]);

  const fetchCatOptions = useCallback((q: string, append = false) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoadingCat(true);
      try {
        const params = new URLSearchParams({ shop: shopDomain, type: "category", limit: "200", configId });
        if (q) params.set("q", q);
        if (append && catOffset > 0) params.set("offset", String(catOffset));
        if (selectedCategories.length > 0) params.set("selected", selectedCategories.join(","));
        const res = await fetch(`/api/csv-options?${params}`);
        const d = await res.json();
        if (append) {
          setCatOptions((prev) => [...prev, ...(d.options || [])]);
        } else {
          setCatOptions(d.options || []);
          setCatOffset(0);
        }
        setCatTotal(d.total || 0);
        setCatOffset((append ? catOffset : 0) + (d.options?.length || 0));
      } catch { if (!append) setCatOptions([]); }
      finally { setLoadingCat(false); }
    }, 300);
  }, [shopDomain, configId, catOffset, selectedCategories]);

  useEffect(() => { if (filterByCategory) { setCatOffset(0); fetchCatOptions(""); } }, [filterByCategory]);
  useEffect(() => { if (filterBySku) { setSkuOffset(0); fetchSkuOptions(""); } }, [filterBySku]);

  const [initialFilter, setInitialFilter] = useState({ skus: "", categories: "" });
  const derivedFilterType = filterBySku && filterByCategory ? "both" : filterBySku ? "skus" : filterByCategory ? "categories" : "all";

  useEffect(() => {
    const key = `${filterBySku}|${selectedSkus.sort().join(",")}|${filterByCategory}|${selectedCategories.sort().join(",")}`;
    const initKey = `${!!initialFilter.skus}|${initialFilter.skus}|${!!initialFilter.categories}|${initialFilter.categories}`;
    setFilterDirty(key !== initKey);
  }, [filterBySku, selectedSkus, filterByCategory, selectedCategories, initialFilter]);

  useEffect(() => {
    if (filterFetcher.data?.success) {
      setInitialFilter({
        skus: selectedSkus.sort().join(","),
        categories: selectedCategories.sort().join(","),
      });
      setFilterDirty(false);
    }
  }, [filterFetcher.data]);

  const saveFilter = () => {
    const formData = new FormData();
    formData.set("shop", shopDomain);
    formData.set("configId", configId);
    formData.set("filterType", derivedFilterType);
    formData.set("filterSkus", selectedSkus.join(","));
    formData.set("filterCategories", selectedCategories.join(","));
    filterFetcher.submit(formData, { method: "post", action: "/api/filter" });
  };

  const resetFilter = () => {
    setFilterBySku(!!initialFilter.skus);
    setFilterByCategory(!!initialFilter.categories);
    setSelectedSkus(initialFilter.skus ? initialFilter.skus.split(",") : []);
    setSelectedCategories(initialFilter.categories ? initialFilter.categories.split(",") : []);
    setFilterDirty(false);
  };

  const runImport = async () => {
    const params = new URLSearchParams({ shop: shopDomain, configId });
    if (derivedFilterType !== "all") {
      params.set("filterType", derivedFilterType);
    }
    if (filterBySku && selectedSkus.length > 0) {
      params.set("filterSkus", selectedSkus.join(","));
    }
    if (filterByCategory && selectedCategories.length > 0) {
      params.set("filterCategories", selectedCategories.join(","));
    }
    fetcher.submit(null, {
      method: "POST",
      action: `/api/import?${params}`,
    });
  };

  const runAction = fetcher.data as
    | { success?: boolean; error?: string; bulk?: boolean; message?: string; queued?: boolean; position?: number; result?: { created: number; updated: number; unchanged: number } }
    | null;

  const statusLabel = (status: string) => {
    const map: Record<string, string> = {
      completed: t("common.completed"),
      completed_with_errors: t("import.completedWithErrors"),
      failed: t("common.failed"),
      running: t("common.processing"),
      scheduled: t("common.scheduled"),
    };
    return map[status] || status;
  };

  const rows = (recentLogs || []).map((log: any) => [
    new Date(log.startedAt).toLocaleString("es-ES"),
    <Badge key={log.id} tone={STATUS_TONE[log.status] || "info"}>
      {statusLabel(log.status)}
    </Badge>,
    log.totalProducts,
    log.created,
    log.updated,
    log.excludedCount || 0,
    log.errors ? (JSON.parse(log.errors) as any[]).length : 0,
  ]);

  const basePath = `/app/supplier/${configId}`;

  return (
    <>
      <Layout>
        {runAction?.success && (
          <Layout.Section>
            <Banner tone={runAction.queued ? "warning" : "info"} title={runAction.queued ? t("import.queued") : t("import.launched")}>
              {runAction.message || t("import.launchedMessage")}
              {runAction.queued && (
                <div style={{ marginTop: "8px" }}>
                  <Button url="/app/queue" size="slim">{t("import.viewQueue")}</Button>
                </div>
              )}
            </Banner>
          </Layout.Section>
        )}
        {runAction?.error && (
          <Layout.Section>
            <Banner tone="critical" title={t("import.error")}>
              {runAction.error}
            </Banner>
          </Layout.Section>
        )}
        {importActive && (
          <Layout.Section>
            <Banner tone="info" title={t("import.running")}>
              {t("import.runningMessage")}
            </Banner>
          </Layout.Section>
        )}
        {unresolvedDuplicates > 0 && (
          <Layout.Section>
            <Banner
              tone="warning"
              title={t("import.duplicateProducts", { count: unresolvedDuplicates })}
              action={{ content: t("import.viewDuplicates"), url: "/app/duplicates" }}
            >
              {t("import.duplicateMessage")}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          {config.planPaused ? (
            <Banner tone="warning" title={t("import.planDisabled")}>
              <p>
                {t("import.planDisabledMessage")}
              </p>
            </Banner>
          ) : (
            <InlineStack gap="300" blockAlign="center">
              <span data-tutorial="import-run-btn">
              <Button
                variant="primary"
                onClick={runImport}
                loading={isRunning}
                disabled={isRunning}
              >
                {importActive ? t("import.enqueue") : isRunning ? t("import.launching") : t("import.run")}
              </Button>
              </span>
              <Text as="p" tone="subdued">
                {importActive ? t("import.enqueue") : isRunning ? t("import.launching") : t("import.runTooltip")}
              </Text>
            </InlineStack>
          )}
        </Layout.Section>

        <Layout.Section>
          <form
            ref={filterFormRef}
            onSubmit={(e) => { e.preventDefault(); saveFilter(); }}
            onReset={(e) => { e.preventDefault(); resetFilter(); }}
          >
            <SaveBar id={FILTER_SAVE_BAR_ID}>
              <button variant="primary" type="button" onClick={() => { saveFilter(); shopify.saveBar.hide(FILTER_SAVE_BAR_ID); }}>{t("common.save")}</button>
              <button type="button" onClick={() => { resetFilter(); shopify.saveBar.hide(FILTER_SAVE_BAR_ID); }}>{t("common.discard")}</button>
            </SaveBar>
            <div data-tutorial="import-filters">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">{t("preview.filterProducts")}</Text>
                <input type="hidden" name="shop" value={shopDomain} />
                <input type="hidden" name="configId" value={configId} />
                <input type="hidden" name="filterType" value={derivedFilterType} />
                <input type="hidden" name="filterSkus" value={selectedSkus.join(",")} />
                <input type="hidden" name="filterCategories" value={selectedCategories.join(",")} />
                <Checkbox
                  label={t("preview.allProducts")}
                  checked={!filterBySku && !filterByCategory}
                  onChange={() => { setFilterBySku(false); setFilterByCategory(false); setSelectedSkus([]); setSelectedCategories([]); }}
                />
                <Checkbox
                  label={t("preview.bySku")}
                  checked={filterBySku}
                  onChange={(val) => { setFilterBySku(val); if (!val) setSelectedSkus([]); }}
                />
                {filterBySku && (
                  <SearchableMultiSelect
                    label={t("preview.individualSkus")}
                    options={skuOptions}
                    selected={selectedSkus}
                    onToggle={(val) => setSelectedSkus((prev) => prev.includes(val) ? prev.filter((v) => v !== val) : [...prev, val])}
                    loading={loadingSku}
                    onSearch={(q) => { setSkuOffset(0); fetchSkuOptions(q); }}
                    onLoadMore={() => fetchSkuOptions("", true)}
                    hasMore={skuOffset < skuTotal}
                    placeholder={t("preview.searchSku")}
                  />
                )}
                <Checkbox
                  label={t("preview.byCategories")}
                  checked={filterByCategory}
                  onChange={(val) => { setFilterByCategory(val); if (!val) setSelectedCategories([]); }}
                />
                {filterByCategory && (
                  <SearchableMultiSelect
                    label={t("preview.fileCategories")}
                    options={catOptions}
                    selected={selectedCategories}
                    onToggle={(val) => setSelectedCategories((prev) => prev.includes(val) ? prev.filter((v) => v !== val) : [...prev, val])}
                    loading={loadingCat}
                    onSearch={(q) => { setCatOffset(0); fetchCatOptions(q); }}
                    onLoadMore={() => fetchCatOptions("", true)}
                    hasMore={catOffset < catTotal}
                    placeholder={t("common.search")}
                  />
                )}
              </BlockStack>
            </Card>
            </div>
          </form>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="400">
            <div data-tutorial="import-stats">
            <InlineStack gap="300" wrap>
              <Card>
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">{totalProducts}</Text>
                  <Text as="p" tone="subdued">{t("common.total")}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">{lastLog?.created || 0}</Text>
                  <Text as="p" tone="subdued">{t("common.created")}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">{lastLog?.updated || 0}</Text>
                  <Text as="p" tone="subdued">{t("common.updated")}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">{lastErrors}</Text>
                  <Text as="p" tone="subdued">{t("common.errors")}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">{lastLog?.excludedCount || 0}</Text>
                  <Text as="p" tone="subdued">{t("common.excluded")}</Text>
                </BlockStack>
              </Card>
            </InlineStack>
            </div>

            <div data-tutorial="import-cron">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">{t("tutorial.scheduledImport")}</Text>
                {config?.dataSource === "file" ? (
                  <Banner tone="info">
                    {t("config.manualImportHelp")}
                  </Banner>
                ) : (
                  <>
                    <InlineStack gap="300" blockAlign="center">
                      <Text as="p">
                        <strong>{t("common.status")}:</strong>{" "}
                        <Badge tone={schedulerActive ? "success" : "critical"}>
                          {schedulerActive ? t("common.active") : t("common.inactive")}
                        </Badge>
                      </Text>
                      <Button
                        size="slim"
                        variant={schedulerActive ? "secondary" : "primary"}
                        onClick={toggleScheduler}
                      >
                        {schedulerActive ? t("import.stopCron") : t("import.startCron")}
                      </Button>
                    </InlineStack>
                    <Text as="p" tone="subdued">
                      {schedulerActive
                        ? t("import.runsAt", { frequency: t(FREQUENCY_KEYS[config?.frequency || ""] || config?.frequency || "") })
                        : t("import.autoDisabled")}
                    </Text>
                  </>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">{t("import.configStatus")}</Text>
                <InlineStack gap="200" wrap>
                  {config?.dataSource !== "file" && (
                    <Text as="p">
                      <strong>{t("config.frequency")}:</strong> {t(FREQUENCY_KEYS[config?.frequency || ""] || config?.frequency || "")}
                    </Text>
                  )}
                  <Text as="p">
                    <strong>{t("common.mode")}:</strong> {config?.importMode === "bulk" ? t("common.bulkOperation") : t("common.chunks")}
                  </Text>
                  <Text as="p">
                    <strong>{t("import.lastImport")}:</strong> {lastLog
                      ? new Date(lastLog.startedAt).toLocaleString("es-ES")
                      : t("import.never")}
                  </Text>
                  {lastLog?.lastSku && (
                    <Text as="p">
                      <strong>{t("import.lastSku")}:</strong> {lastLog.lastSku}
                    </Text>
                  )}
                </InlineStack>
                {lastLog && (
                  <InlineStack gap="200">
                    <Text as="p" tone="subdued">{t("import.lastStatus")}:</Text>
                    <Badge tone={STATUS_TONE[lastLog.status] || "info"}>
                      {statusLabel(lastLog.status)}
                    </Badge>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
            </div>

            <div data-tutorial="import-actions">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">{t("common.actions")}</Text>
                <InlineStack gap="200" wrap>
                  <Button onClick={() => navigate(`${basePath}/preview`)}>{t("supplier.preview")}</Button>
                  <Button onClick={() => navigate(`${basePath}/config`)}>{t("supplier.config")}</Button>
                  <Button onClick={() => navigate(`${basePath}/columns`)}>{t("supplier.columns")}</Button>
                  <Button onClick={() => navigate(`${basePath}/price-rules`)}>{t("supplier.priceRules")}</Button>
                  <Button onClick={() => navigate(`${basePath}/category-mapping`)}>{t("supplier.categories")}</Button>
                  <Button onClick={() => navigate(`${basePath}/logs`)}>{t("supplier.history")}</Button>
                </InlineStack>
              </BlockStack>
            </Card>
            </div>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">{t("history.title")}</Text>
                <DataTable
                  columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "numeric", "numeric"]}
                  headings={[t("common.startDate"), t("common.status"), t("common.total"), t("common.created"), t("common.updated"), t("common.excluded"), t("common.errors")]}
                  rows={rows}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </>
  );
}
