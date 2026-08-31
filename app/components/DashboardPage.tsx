import { useState, useEffect, useCallback, useRef } from "react";
import { useFetcher, Link } from "react-router";
import {
  BlockStack,
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  DataTable,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { SearchableMultiSelect } from "~/components/SearchableMultiSelect";
import { useTranslation } from "react-i18next";


const STATUS_TONE: Record<string, "success" | "critical" | "attention" | "info"> = {
  completed: "success",
  completed_with_errors: "attention",
  failed: "critical",
  running: "attention",
  scheduled: "info",
};

export type DashboardData = {
  config: any;
  lastLog: any;
  lastErrors: number;
  totalProducts: number;
  shopDomain: string;
};

export default function DashboardPage({ config, lastLog, lastErrors, totalProducts, shopDomain }: DashboardData) {
  const fetcher = useFetcher();
  const filterFetcher = useFetcher();
  const isRunning = fetcher.state !== "idle";
  const { t } = useTranslation();

  const STATUS_LABEL: Record<string, string> = {
    completed: t("common.completed"),
    completed_with_errors: t("import.completedWithErrors"),
    failed: t("common.failed"),
    running: t("common.processing"),
    scheduled: t("common.scheduled"),
  };

  const FREQUENCY_LABEL: Record<string, string> = {
    "30min": t("frequency.every30min"),
    hourly: t("frequency.hourly"),
    "2h": t("frequency.every2h"),
    "3h": t("frequency.every3h"),
    "4h": t("frequency.every4h"),
    "6h": t("frequency.every6h"),
    "12h": t("frequency.every12h"),
    daily: t("frequency.daily"),
    weekly: t("frequency.weekly"),
  };

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
  const [schedulerActive, setSchedulerActive] = useState(config?.isActive ?? true);

  const toggleScheduler = () => {
    const newActive = !schedulerActive;
    setSchedulerActive(newActive);
    const formData = new FormData();
    formData.set("shop", shopDomain);
    formData.set("isActive", String(newActive));
    filterFetcher.submit(formData, { method: "post", action: "/api/filter" });
  };

  useEffect(() => {
    fetch(`/api/filter?shop=${shopDomain}`)
      .then((r) => r.json())
      .then((d) => {
        const hasSkus = !!(d.filterSkus && d.filterSkus.trim());
        const hasCats = !!(d.filterCategories && d.filterCategories.trim());
        setFilterBySku(hasSkus || d.filterType === "skus");
        setFilterByCategory(hasCats || d.filterType === "categories");
        if (d.filterSkus) setSelectedSkus(d.filterSkus.split(",").filter(Boolean));
        if (d.filterCategories) setSelectedCategories(d.filterCategories.split(",").filter(Boolean));
        setInitialFilter({
          skus: d.filterSkus || "",
          categories: d.filterCategories || "",
        });
      })
      .catch(() => {});
  }, [shopDomain]);

  const fetchSkuOptions = useCallback((q: string, append = false) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoadingSku(true);
      try {
        const params = new URLSearchParams({ shop: shopDomain, type: "sku", limit: "200" });
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
  }, [shopDomain, skuOffset, selectedSkus]);

  const fetchCatOptions = useCallback((q: string, append = false) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoadingCat(true);
      try {
        const params = new URLSearchParams({ shop: shopDomain, type: "category", limit: "200" });
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
  }, [shopDomain, catOffset, selectedCategories]);

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
    const idToken =
      new URLSearchParams(window.location.search).get("id_token") || "";
    const params = new URLSearchParams({ shop: shopDomain, id_token: idToken });
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
    | { success?: boolean; error?: string; bulk?: boolean; message?: string; result?: { created: number; updated: number; unchanged: number } }
    | null;

  const rows = (config?.logs || []).map((log: any) => [
    new Date(log.startedAt).toLocaleString("es-ES"),
    log.status,
    log.totalProducts,
    log.created,
    log.updated,
    log.excludedCount || 0,
    log.errors ? (JSON.parse(log.errors) as any[]).length : 0,
  ]);

  return (
    <Page
      title={t("dashboardPage.importTitle")}
      subtitle={t("dashboardPage.importSubtitle")}
      primaryAction={
        <Button
          variant="primary"
          onClick={runImport}
          loading={isRunning}
          disabled={isRunning}
        >
          {isRunning ? t("dashboardPage.importing") : t("import.run")}
        </Button>
      }
    >
      <Layout>
        {runAction?.success && (
          <Layout.Section>
            <Banner tone="info" title={t("import.launched")}>
              {runAction.message || t("import.launchedMessage")}
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

        <Layout.Section>
          <form
            ref={filterFormRef}
            data-save-bar
            onSubmit={(e) => { e.preventDefault(); saveFilter(); }}
            onReset={(e) => { e.preventDefault(); resetFilter(); }}
          >
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">{t("preview.filterProducts")}</Text>
                <input type="hidden" name="shop" value={shopDomain} />
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
                    placeholder={t("categories.searchCategories")}
                  />
                )}
              </BlockStack>
            </Card>
          </form>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="400">
            <InlineStack gap="300" wrap>
              <Card>
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">{totalProducts}</Text>
                  <Text as="p" tone="subdued">{t("columns.columnsDetected", { count: totalProducts }).split(".")[0]}{t("common.total")}</Text>
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

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">{t("import.scheduledImport")}</Text>
                <InlineStack gap="300" blockAlign="center">
                  <Text as="p">
                    <strong>{t("common.status")}:</strong>{" "}
                    <Badge tone={schedulerActive ? "success" : "critical"}>
                      {schedulerActive ? t("common.active") : t("import.stopCron")}
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
                    ? t("import.runsAt", { frequency: FREQUENCY_LABEL[config?.frequency || ""] || config?.frequency || "—" })
                    : t("import.autoDisabled")}
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">{t("import.configStatus")}</Text>
                <InlineStack gap="200" wrap>
                  <Text as="p">
                    <strong>{t("config.frequency")}:</strong> {FREQUENCY_LABEL[config?.frequency || ""] || config?.frequency || "—"}
                  </Text>
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
                      {STATUS_LABEL[lastLog.status] || lastLog.status}
                    </Badge>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">{t("common.actions")}</Text>
                <InlineStack gap="200" wrap>
                  <Link to={`/app/preview?shop=${shopDomain}`}>
                    <Button>{t("common.view")} {t("supplier.preview")}</Button>
                  </Link>
                  <Link to={`/app/config?shop=${shopDomain}`}>
                    <Button>{t("supplier.config")}</Button>
                  </Link>
                  <Link to={`/app/columns?shop=${shopDomain}`}>
                    <Button>{t("supplier.columns")}</Button>
                  </Link>
                  <Link to={`/app/price-rules?shop=${shopDomain}`}>
                    <Button>{t("supplier.priceRules")}</Button>
                  </Link>
                  <Link to={`/app/category-mapping?shop=${shopDomain}`}>
                    <Button>{t("supplier.categories")}</Button>
                  </Link>
                  <Link to={`/app/logs?shop=${shopDomain}`}>
                    <Button>{t("supplier.history")}</Button>
                  </Link>
                </InlineStack>
              </BlockStack>
            </Card>

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
    </Page>
  );
}
