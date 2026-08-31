import { useState, useCallback, useRef, useEffect } from "react";
import { Checkbox, TextField, Text, Button, BlockStack, InlineStack, Spinner, Tag } from "@shopify/polaris";
import { useTranslation } from "react-i18next";

export function SearchableMultiSelect({
  label,
  options,
  selected,
  disabledValues = [],
  onToggle,
  loading,
  onSearch,
  onLoadMore,
  hasMore,
  placeholder,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  disabledValues?: string[];
  onToggle: (val: string) => void;
  loading: boolean;
  onSearch: (q: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  placeholder?: string;
}) {
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  const handleSearch = useCallback((q: string) => {
    setSearch(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearch(q), 300);
  }, [onSearch]);

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current || !onLoadMore || loading || !hasMore) return;
    const el = scrollRef.current;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 20) {
      onLoadMore();
    }
  }, [onLoadMore, loading, hasMore]);

  const filtered = options
    .sort((a, b) => {
      const aSel = selected.includes(a.value) ? 0 : 1;
      const bSel = selected.includes(b.value) ? 0 : 1;
      return aSel - bSel;
    });

  const disabledSet = new Set(disabledValues);

  const selectedLabels = [...new Set([...selected, ...disabledValues])].map((val) => {
    const opt = options.find((o) => o.value === val);
    return { value: val, label: opt?.label || val };
  });

  return (
    <BlockStack gap="200">
      <TextField
        label={label}
        value={search}
        onChange={handleSearch}
        autoComplete="off"
        placeholder={placeholder || t("common.search")}
        helpText={`${selected.length} ${t("common.selected")} · ${options.length} ${t("common.loaded")}`}
      />
      {selectedLabels.length > 0 && (
        <InlineStack gap="100" wrap>
          {selectedLabels.map((item) => {
            const isDisabled = disabledSet.has(item.value);
            return (
              <Tag key={item.value} onRemove={isDisabled ? undefined : () => onToggle(item.value)}>
                {item.label}
              </Tag>
            );
          })}
        </InlineStack>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ maxHeight: "250px", overflowY: "auto", border: "1px solid #ddd", borderRadius: "4px", padding: "8px" }}
      >
        {loading && options.length === 0 && <Text as="p" tone="subdued">{t("common.loading")}</Text>}
        {!loading && filtered.length === 0 && (
          <Text as="p" tone="subdued">{t("common.noResults")}</Text>
        )}
        {filtered.map((opt) => {
          const isDisabled = disabledSet.has(opt.value);
          return (
            <Checkbox
              key={opt.value || opt.label}
              label={opt.label || opt.value || "—"}
              checked={selected.includes(opt.value) || isDisabled}
              disabled={isDisabled}
              onChange={() => { if (!isDisabled) onToggle(opt.value); }}
            />
          );
        })}
        {hasMore && !loading && (
          <div style={{ padding: "8px 0", textAlign: "center" }}>
            <Button variant="plain" onClick={onLoadMore}>
              {t("common.loadMore")}
            </Button>
          </div>
        )}
        {loading && options.length > 0 && (
          <div style={{ padding: "8px 0", textAlign: "center" }}>
            <InlineStack gap="200" align="center" blockAlign="center">
              <Spinner size="small" />
              <Text as="p" tone="subdued">{t("common.loadingMore")}</Text>
            </InlineStack>
          </div>
        )}
      </div>
    </BlockStack>
  );
}
