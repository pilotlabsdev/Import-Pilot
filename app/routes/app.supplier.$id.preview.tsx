import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  InlineStack,
  Pagination,
  ProgressBar,
  Spinner,
  Text,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { SearchableMultiSelect } from "~/components/SearchableMultiSelect";
import { useTranslation } from "react-i18next";

const CHUNK_SIZE = 5000;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configId = params.id as string;
  return data({ shopDomain, configId });
}

export default function Preview() {
  const { shopDomain, configId } = useLoaderData<typeof loader>();
  const { t } = useTranslation();

  const [preview, setPreview] = useState<any[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [importFilteredTotal, setImportFilteredTotal] = useState(0);
  const [stats, setStats] = useState<{ creates: number; updates: number; unchanged: number; excluded: number } | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingPhase, setLoadingPhase] = useState<"idle" | "streaming" | "stats">("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);
  const loadIdRef = useRef(0);

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

  const fetchSkuOptions = useCallback((q: string, append = false) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoadingSku(true);
      try {
        const params = new URLSearchParams({ shop: shopDomain, type: "sku", limit: "200", configId });
        if (q) params.set("q", q);
        if (append && skuOffset > 0) params.set("offset", String(skuOffset));
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
  }, [shopDomain, configId, skuOffset]);

  const fetchCatOptions = useCallback((q: string, append = false) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoadingCat(true);
      try {
        const params = new URLSearchParams({ shop: shopDomain, type: "category", limit: "200", configId });
        if (q) params.set("q", q);
        if (append && catOffset > 0) params.set("offset", String(catOffset));
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
  }, [shopDomain, configId, catOffset]);

  const stopLoading = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    loadingRef.current = false;
    setLoadingPhase("idle");
  }, []);

  const loadPreviewStream = useCallback(async (reset = true) => {
    if (loadingRef.current) stopLoading();
    await new Promise(r => setTimeout(r, 50));

    const myLoadId = ++loadIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    loadingRef.current = true;

    if (reset) {
      setPreview([]);
      setPage(1);
      setFilteredTotal(0);
      setLoadingProgress(0);
    }
    setLoading(true);
    setError(null);
    setStats(null);
    setLoadingPhase("streaming");

    try {
      let currentPage = 1;
      let allItems: any[] = reset ? [] : [...preview];
      let total = 0;
      let fTotal = 0;
      let impTotal = 0;

      while (!controller.signal.aborted) {
        const params = new URLSearchParams({
          shop: shopDomain,
          page: String(currentPage),
          perPage: String(CHUNK_SIZE),
          configId,
          computeStats: "0",
        });
        if (selectedSkus.length > 0) params.set("filterSkus", selectedSkus.join(","));
        if (selectedCategories.length > 0) params.set("filterCategories", selectedCategories.join(","));

        const res = await fetch(`/api/preview?${params}`, { signal: controller.signal });
        if (!res.ok) {
          if (res.status === 401) {
            throw new Error(t("common.sessionExpired") || "Sesión expirada. Recarga la página.");
          }
          const text = await res.text().catch(() => "");
          throw new Error(text || `HTTP ${res.status}`);
        }
        const d = await res.json();

        if (loadIdRef.current !== myLoadId) return;

        if (d.error) {
          setError(d.error);
          break;
        }

        const newItems = d.preview || [];
        allItems = [...allItems, ...newItems];
        total = d.totalRows || 0;
        fTotal = d.filteredTotal || 0;
        impTotal = d.importFilteredTotal || 0;

        setPreview([...allItems]);
        setTotalRows(total);
        setFilteredTotal(fTotal);
        setImportFilteredTotal(impTotal);
        setPage(currentPage);
        setLoadingProgress(allItems.length);

        if (newItems.length < CHUNK_SIZE || allItems.length >= total) {
          break;
        }

        currentPage++;
        await new Promise(r => setTimeout(r, 50));
      }

      if (loadIdRef.current !== myLoadId) return;

      if (!controller.signal.aborted && fTotal > 0) {
        setLoadingPhase("stats");
        try {
          const statsParams = new URLSearchParams({
            shop: shopDomain,
            configId,
            computeStats: "1",
            page: "1",
            perPage: "1",
          });
          if (selectedSkus.length > 0) statsParams.set("filterSkus", selectedSkus.join(","));
          if (selectedCategories.length > 0) statsParams.set("filterCategories", selectedCategories.join(","));
          const statsRes = await fetch(`/api/preview?${statsParams}`, { signal: controller.signal });
          if (statsRes.ok) {
            const sd = await statsRes.json();
            if (loadIdRef.current !== myLoadId) return;
            setStats(sd.stats || { creates: 0, updates: 0, unchanged: 0, excluded: 0 });
          }
        } catch {}
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setError(e.message);
      }
    } finally {
      if (loadIdRef.current === myLoadId) {
        loadingRef.current = false;
        setLoadingPhase("idle");
        setLoading(false);
      }
    }
  }, [shopDomain, configId, selectedSkus, selectedCategories, stopLoading]);

  useEffect(() => { loadPreviewStream(true); }, []);
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);
  useEffect(() => { if (filterByCategory) { setCatOffset(0); fetchCatOptions(""); } }, [filterByCategory]);
  useEffect(() => { if (filterBySku) { setSkuOffset(0); fetchSkuOptions(""); } }, [filterBySku]);

  const [page, setPage] = useState(1);
  const totalPages = Math.ceil(filteredTotal / CHUNK_SIZE);

  const [tablePage, setTablePage] = useState(1);
  const TABLE_PAGE_SIZE = 50;

  const isLoadingChunks = loadingPhase === "streaming";
  const isLoadingStats = loadingPhase === "stats";
  const progressPercent = filteredTotal > 0 ? Math.min((loadingProgress / filteredTotal) * 100, 100) : 0;
  const hasAnyPreviewFilter = (filterBySku && selectedSkus.length > 0) || (filterByCategory && selectedCategories.length > 0);

  useEffect(() => { setTablePage(1); }, [preview.length, filterBySku, filterByCategory, selectedSkus, selectedCategories]);

  const rows = preview.map((p) => {
    const priceDiff = p.shopifyPrice !== null && Math.abs(p.regularPrice - p.shopifyPrice) > 0.001;
    const compareDiff = p.shopifyCompareAtPrice !== null && p.shopifyCompareAtPrice > 0 && Math.abs(p.compareAtPrice - p.shopifyCompareAtPrice) > 0.001;
    const stockDiff = p.stockFromCsv !== p.shopifyStock;

    const diffStyle = (diff: boolean): React.CSSProperties => diff ? { color: "#d82c0d", fontWeight: "bold" } : {};

    return [
      <code key={`s-${p.sku}`}>{p.sku}</code>,
      p.ean || "—",
      p.name,
      <Badge
        key={`a-${p.sku}`}
        tone={p.action === "create" ? "success" : p.action === "update" ? "attention" : p.action === "skip" ? "critical" : p.action === "excluded" ? "critical" : "info"}
      >
        {p.action === "create" ? t("preview.createAction") : p.action === "update" ? t("preview.updateAction") : p.action === "skip" ? t("preview.skipStockZero") : p.action === "excluded" ? t("preview.excludeAction") : t("preview.unchangedAction")}
      </Badge>,
      `${p.costPrice.toFixed(2)} €`,
      <span key={`p-${p.sku}`} style={{ fontWeight: "bold" }}>
        {p.regularPrice.toFixed(2)} €
      </span>,
      p.compareAtPrice ? `${p.compareAtPrice.toFixed(2)} €` : "—",
      p.shopifyPrice !== null ? (
        <span key={`sp-${p.sku}`} style={diffStyle(priceDiff)}>
          {p.shopifyPrice.toFixed(2)} €{priceDiff ? " *" : ""}
        </span>
      ) : "—",
      p.shopifyCompareAtPrice !== null && p.shopifyCompareAtPrice > 0 ? (
        <span key={`sc-${p.sku}`} style={diffStyle(compareDiff)}>
          {p.shopifyCompareAtPrice.toFixed(2)} €{compareDiff ? " *" : ""}
        </span>
      ) : "—",
      String(p.stockFromCsv),
      <span key={`ss-${p.sku}`} style={diffStyle(stockDiff)}>
        {String(p.shopifyStock)}{stockDiff ? " *" : ""}
      </span>,
      String(p.totalStock ?? 0),
      p.category,
      p.errors.length > 0 ? (
        p.errors.map((e: string) => (
          <Badge key={e} tone="critical">{e}</Badge>
        ))
      ) : (
        <Badge key={p.sku} tone="success">{t("preview.okStatus")}</Badge>
      ),
    ];
  });

  const tableTotalPages = Math.ceil(rows.length / TABLE_PAGE_SIZE);
  const tableRows = rows.slice((tablePage - 1) * TABLE_PAGE_SIZE, tablePage * TABLE_PAGE_SIZE);

  return (
    <BlockStack gap="400">
      <div data-tutorial="preview-filters">
      <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t("preview.filterProducts")}</Text>
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
            <InlineStack gap="200">
              <Button variant="primary" onClick={() => loadPreviewStream(true)} disabled={isLoadingChunks}>
                {isLoadingChunks ? t("common.loading") : t("preview.updatePreview")}
              </Button>
              {isLoadingChunks && (
                <Button onClick={stopLoading}>
                  {t("common.stop")}
                </Button>
              )}
            </InlineStack>
          </BlockStack>
        </Card>
        </div>

        {isLoadingChunks && (
          <Card>
            <BlockStack gap="200">
              <InlineStack gap="300" blockAlign="center">
                <Spinner size="small" />
                <Text as="p">
                  {t("preview.loadingChunk", {
                    loaded: loadingProgress.toLocaleString(),
                    total: filteredTotal > 0 ? filteredTotal.toLocaleString() : "?"
                  })}
                </Text>
              </InlineStack>
              {filteredTotal > 0 && (
                <ProgressBar progress={Math.round(progressPercent)} size="small" />
              )}
            </BlockStack>
          </Card>
        )}

        {isLoadingStats && (
          <Card>
            <InlineStack gap="300" blockAlign="center">
              <Spinner size="small" />
              <Text as="p">{t("preview.loadingStats")}</Text>
            </InlineStack>
          </Card>
        )}

        {error && (
          <Banner tone="critical">
            <Text as="p">{error}</Text>
          </Banner>
        )}

        {preview.length > 0 && (
          <>
            <div data-tutorial="preview-stats">
            <InlineStack gap="300" wrap>
              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="headingXl" alignment="center">{totalRows.toLocaleString()}</Text>
                  <Text as="p" variant="bodySm" tone="subdued" alignment="center">{t("preview.totalRows")}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="headingXl" alignment="center">
                    {hasAnyPreviewFilter ? filteredTotal.toLocaleString() : totalRows.toLocaleString()}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued" alignment="center">{t("preview.filteredPreview")}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="headingXl" alignment="center">{importFilteredTotal.toLocaleString()}</Text>
                  <Text as="p" variant="bodySm" tone="subdued" alignment="center">{t("preview.filteredImport")}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="headingXl" alignment="center">
                    {stats === null ? (statsLoading || isLoadingStats ? "..." : "-") : stats.creates.toLocaleString()}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued" alignment="center">{t("preview.toCreate")}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="headingXl" alignment="center">
                    {stats === null ? (statsLoading || isLoadingStats ? "..." : "-") : stats.updates.toLocaleString()}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued" alignment="center">{t("preview.toUpdate")}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="headingXl" alignment="center">
                    {stats === null ? (statsLoading || isLoadingStats ? "..." : "-") : stats.unchanged.toLocaleString()}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued" alignment="center">{t("common.unchanged")}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="headingXl" alignment="center">
                    {stats === null ? (statsLoading || isLoadingStats ? "..." : "-") : stats.excluded.toLocaleString()}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued" alignment="center">{t("common.excluded")}</Text>
                </BlockStack>
              </Card>
            </InlineStack>
            </div>

            <div data-tutorial="preview-table">
            <Card padding="0">
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "text", "text"]}
                  headings={[t("common.sku"), t("common.ean"), t("common.name"), t("preview.action"), t("preview.cost"), t("common.price"), t("preview.comparison"), t("preview.priceComparison"), t("preview.compareShopify"), t("preview.stockCsv"), t("preview.stockShopify"), t("preview.stockTotal"), t("common.category"), t("common.errors")]}
                  rows={tableRows}
                />
              </Card>
              {tableTotalPages > 1 && (
                <div style={{ marginTop: "1rem", display: "flex", justifyContent: "center" }}>
                  <Pagination
                    label={`${tablePage} / ${tableTotalPages}`}
                    hasPrevious={tablePage > 1}
                    onPrevious={() => setTablePage((p) => Math.max(1, p - 1))}
                    hasNext={tablePage < tableTotalPages}
                    onNext={() => setTablePage((p) => Math.min(tableTotalPages, p + 1))}
                  />
                </div>
              )}
              <Text as="p" variant="bodySm" tone="subdued">
                {t("preview.diffNote")}
              </Text>
              </div>
          </>
        )}
      </BlockStack>
  );
}
