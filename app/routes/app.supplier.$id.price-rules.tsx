import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data } from "react-router";

import { useLoaderData, useActionData, Form, useRevalidator, useNavigation } from "react-router";
import { useState, useCallback, useRef, useEffect } from "react";
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
  Modal,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { SearchableMultiSelect } from "~/components/SearchableMultiSelect";
import { prisma, getConfigById } from "~/lib/db.server";
import { evaluateFormula } from "~/lib/formula-parser";
import { authenticate } from "~/shopify.server";
import { ViewIcon } from "@shopify/polaris-icons";
import { useTranslation } from "react-i18next";

function getRoundingOptions(t: (key: string) => string) {
  return [
    { label: t("priceRules.noRounding"), value: "none" },
    { label: t("priceRules.round95"), value: "0.95" },
    { label: t("priceRules.round99"), value: "0.99" },
    { label: t("priceRules.customRound"), value: "custom" },
  ];
}

function getRuleTypeOptions(t: (key: string) => string) {
  return [
    { label: t("priceRules.general"), value: "general" },
    { label: t("priceRules.byCategory"), value: "category" },
    { label: t("priceRules.bySku"), value: "product" },
  ];
}

function getCompareBasisOptions(t: (key: string) => string) {
  return [
    { label: t("priceRules.compareC"), value: "cost" },
    { label: t("priceRules.compareX"), value: "regular" },
  ];
}

function getCompareTypeOptions(t: (key: string) => string) {
  return [
    { label: t("priceRules.compareFormula"), value: "formula" },
    { label: t("priceRules.compareFixed"), value: "fixed" },
    { label: t("priceRules.comparePercent"), value: "percentage" },
  ];
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configId = params.id as string;

  const config = await getConfigById(configId);
  if (!config || config.shopDomain !== shopDomain) throw new Response("Not found", { status: 404 });

  const rules = await prisma.priceRule.findMany({
    where: { configId: config.id },
    orderBy: { createdAt: "asc" },
  });

  const categoryRules = rules.filter((r) => r.ruleType === "category");
  const usedCategories: string[] = [...new Set(categoryRules.flatMap((r) => {
    if (!r.targetValue) return [];
    try {
      const arr = JSON.parse(r.targetValue);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }))];

  return data({ rules, shopDomain, configId: config.id, usedCategories });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configIdParam = params.id as string;

  const formData = await request.formData();
  const configId = formData.get("configId") as string;
  const intent = formData.get("intent") as string;

  if (!configId) return data({ error: "Configuración no encontrada" });

  if (intent === "create" || intent === "update") {
    const ruleId = intent === "update" ? (formData.get("ruleId") as string) : undefined;
    const name = formData.get("name") as string;
    const priceFormula = (formData.get("priceFormula") as string) || "C";
    const comparePriceFormula = (formData.get("comparePriceFormula") as string) || "";
    const comparePriceBasis = (formData.get("comparePriceBasis") as string) || "cost";
    const comparePriceType = (formData.get("comparePriceType") as string) || "formula";
    const comparePriceFixedValueStr = formData.get("comparePriceFixedValue") as string;
    const comparePriceFixedValue = comparePriceFixedValueStr ? parseFloat(comparePriceFixedValueStr) : null;
    const comparePricePercentageStr = formData.get("comparePricePercentage") as string;
    const comparePricePercentage = comparePricePercentageStr ? parseFloat(comparePricePercentageStr) : null;
    const compareRoundingType = (formData.get("compareRoundingType") as string) || "none";
    const compareRoundingCustomStr = formData.get("compareRoundingCustom") as string;
    const compareRoundingCustom = compareRoundingCustomStr ? parseFloat(compareRoundingCustomStr) : null;
    const roundingType = (formData.get("roundingType") as string) || "none";
    const roundingCustomStr = formData.get("roundingCustom") as string;
    const roundingCustom = roundingCustomStr ? parseFloat(roundingCustomStr) : null;
    const priority = parseInt((formData.get("priority") as string) || "100");
    const ruleType = (formData.get("ruleType") as string) || "general";
    const rawTargets = formData.getAll("targetValue") as string[];
    const targetValues = [...new Set(rawTargets.filter((v) => v && v.trim()))];
    const targetValue = targetValues.length > 0 ? JSON.stringify(targetValues) : null;

    const useRanges = formData.get("useRanges") === "on";
    let priceRanges: any = undefined;

    if (useRanges && (ruleType === "general" || ruleType === "category")) {
      const rangeIndices = formData.getAll("rangeIndex") as string[];
      const ranges: any[] = [];
      for (const idxStr of rangeIndices) {
        const idx = parseInt(idxStr);
        const rMin = (formData.get(`range_${idx}_min`) as string) || "";
        const rMax = (formData.get(`range_${idx}_max`) as string) || "";
        const rFormula = (formData.get(`range_${idx}_formula`) as string) || "C";
        const rRoundingType = (formData.get(`range_${idx}_roundingType`) as string) || "none";
        const rRoundingCustomStr = formData.get(`range_${idx}_roundingCustom`) as string;
        const rRoundingCustom = rRoundingCustomStr ? parseFloat(rRoundingCustomStr) : null;
        const rCompareEnabled = formData.get(`range_${idx}_compareEnabled`) === "true";
        const rCompareBasis = (formData.get(`range_${idx}_compareBasis`) as string) || "cost";
        const rCompareType = (formData.get(`range_${idx}_compareType`) as string) || "formula";
        const rCompareFormula = (formData.get(`range_${idx}_compareFormula`) as string) || "";
        const rCompareFixedStr = formData.get(`range_${idx}_compareFixedValue`) as string;
        const rCompareFixed = rCompareFixedStr ? parseFloat(rCompareFixedStr) : null;
        const rComparePctStr = formData.get(`range_${idx}_comparePercentage`) as string;
        const rComparePct = rComparePctStr ? parseFloat(rComparePctStr) : null;
        const rCompareRoundingType = (formData.get(`range_${idx}_compareRoundingType`) as string) || "none";
        const rCompareRoundingCustomStr = formData.get(`range_${idx}_compareRoundingCustom`) as string;
        const rCompareRoundingCustom = rCompareRoundingCustomStr ? parseFloat(rCompareRoundingCustomStr) : null;

        ranges.push({
          min: rMin,
          max: rMax,
          formula: rFormula,
          roundingType: rRoundingType,
          roundingCustom: rRoundingCustom != null ? String(rRoundingCustom) : "",
          compareEnabled: rCompareEnabled,
          compareBasis: rCompareBasis,
          compareType: rCompareType,
          compareFormula: rCompareFormula,
          compareFixedValue: rCompareFixed != null ? String(rCompareFixed) : "",
          comparePercentage: rComparePct != null ? String(rComparePct) : "",
          compareRoundingType: rCompareRoundingType,
          compareRoundingCustom: rCompareRoundingCustom != null ? String(rCompareRoundingCustom) : "",
        });
      }
      if (ranges.length > 0) {
        priceRanges = JSON.stringify(ranges);
      }
    }

    try {
      const testResult = evaluateFormula(priceFormula, 10);
      if (testResult < 0) {
        return data({ error: `Fórmula "${priceFormula}" devolvió precio negativo con C=10` });
      }
    } catch (e: any) {
      return data({ error: `Error en fórmula "${priceFormula}": ${e.message}` });
    }

    if (comparePriceType === "formula" && comparePriceFormula) {
      try {
        const testResult = evaluateFormula(comparePriceFormula, 10);
        if (testResult < 0) {
          return data({ error: `Fórmula de comparación "${comparePriceFormula}" devolvió precio negativo` });
        }
      } catch (e: any) {
        return data({ error: `Error en fórmula de comparación: ${e.message}` });
      }
    }

    if (comparePriceType === "fixed" && comparePriceFixedValue != null && comparePriceFixedValue < 0) {
      return data({ error: "El precio fijo de comparación no puede ser negativo" });
    }

    if (comparePriceType === "percentage" && comparePricePercentage != null && comparePricePercentage < -100) {
      return data({ error: "El porcentaje de comparación no puede ser menor a -100" });
    }

    if (priceRanges) {
      try {
        const parsed: PriceRangeRow[] = JSON.parse(priceRanges);
        for (const r of parsed) {
          if (r.min && r.max && parseFloat(r.min) > parseFloat(r.max)) {
            return data({ error: `Rango inválido: min (${r.min}) es mayor que max (${r.max})` });
          }
          if (r.formula) {
            try {
              const test = evaluateFormula(r.formula, 10);
              if (test < 0) {
                return data({ error: `Fórmula de rango "${r.formula}" devolvió precio negativo` });
              }
            } catch (e: any) {
              return data({ error: `Error en fórmula de rango "${r.formula}": ${e.message}` });
            }
          }
        }
      } catch {
        return data({ error: "Error al parsear rangos de precio" });
      }
    }

    const compareEnabled = comparePriceType === "formula"
      ? !!comparePriceFormula
      : comparePriceType === "fixed"
        ? comparePriceFixedValue != null
        : comparePricePercentage != null;

    const ruleData = {
      name,
      ruleType,
      targetValue,
      priceFormula,
      priceRanges,
      comparePriceEnabled: compareEnabled,
      comparePriceBasis,
      comparePriceType,
      comparePriceFormula: comparePriceFormula || "C",
      comparePriceFixedValue,
      comparePricePercentage,
      compareRoundingType,
      compareRoundingCustom,
      roundingType,
      roundingCustom,
    };

    if (intent === "create") {
      const existing = await prisma.priceRule.findFirst({
        where: {
          configId,
          name,
          ruleType,
          targetValue: targetValue || null,
        },
      });
      if (existing) {
        return data({ error: `Ya existe una regla "${name}" (${ruleType}) con los mismos targets para este proveedor` });
      }
      await prisma.priceRule.create({
        data: {
          configId,
          shopDomain,
          ...ruleData,
          isActive: true,
        },
      });
    } else if (intent === "update" && ruleId) {
      await prisma.priceRule.update({
        where: { id: ruleId },
        data: ruleData,
      });
    }
  } else if (intent === "delete") {
    const ruleId = formData.get("ruleId") as string;
    await prisma.priceRule.delete({ where: { id: ruleId } });
  } else if (intent === "toggle") {
    const ruleId = formData.get("ruleId") as string;
    const current = await prisma.priceRule.findUnique({ where: { id: ruleId } });
    if (current) {
      await prisma.priceRule.update({
        where: { id: ruleId },
        data: { isActive: !current.isActive },
      });
    }
  }

  return data({ success: true });
};

function SearchableTargetPicker({
  ruleType,
  values,
  onToggle,
  shopDomain,
  configId,
  disabledValues = [],
}: {
  ruleType: string;
  values: string[];
  onToggle: (val: string) => void;
  shopDomain: string;
  configId: string;
  disabledValues?: string[];
}) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  const isCategory = ruleType === "category";
  const isProduct = ruleType === "product";

  const fetchOptions = useCallback(
    (q: string, append = false) => {
      const type = isCategory ? "category" : "sku";
      const params = new URLSearchParams({ shop: shopDomain, type, limit: "200", configId });
      if (q) params.set("q", q);
      if (append && offset > 0) params.set("offset", String(offset));

      setLoading(true);
      fetch(`/api/csv-options?${params}`)
        .then((res) => res.json())
        .then((data) => {
          if (append) {
            setOptions((prev) => [...prev, ...(data.options || [])]);
          } else {
            setOptions(data.options || []);
            setOffset(0);
          }
          setTotal(data.total || 0);
          setOffset((append ? offset : 0) + (data.options?.length || 0));
        })
        .catch(() => { if (!append) setOptions([]); })
        .finally(() => setLoading(false));
    },
    [shopDomain, configId, isCategory, offset]
  );

  useEffect(() => {
    if ((isCategory || isProduct)) {
      setOffset(0);
      fetchOptions("");
    }
  }, [isCategory, isProduct, shopDomain, configId]);

  useEffect(() => {
    if (ruleType === "general") {
      setOptions([]);
    }
  }, [ruleType]);

  if (ruleType === "general") {
    return (
      <TextField
        label={t("priceRules.formula")}
        value=""
        onChange={() => {}}
        disabled
        autoComplete="off"
        helpText={t("priceRules.formulaHelp")}
      />
    );
  }

  const label = isCategory ? t("common.category") : t("common.sku");
  const placeholder = isCategory ? t("categories.searchCategories") : t("preview.searchSku");

  const effectiveValues = [...new Set([...values, ...disabledValues])];

  return (
    <>
      {effectiveValues.map((v, i) => (
        <input key={`tv-${i}`} type="hidden" name="targetValue" value={v} />
      ))}
      <SearchableMultiSelect
        label={`${t("priceRules.formula")} (${label})`}
        options={options}
        selected={values}
        disabledValues={disabledValues}
        onToggle={onToggle}
        loading={loading}
        onSearch={(q) => { setOffset(0); fetchOptions(q); }}
        onLoadMore={() => fetchOptions("", true)}
        hasMore={offset < total}
        placeholder={placeholder}
      />
    </>
  );
}
interface PriceRangeRow {
  min: string;
  max: string;
  formula: string;
  roundingType: string;
  roundingCustom: string;
  compareEnabled: boolean;
  compareBasis: string;
  compareType: string;
  compareFormula: string;
  compareFixedValue: string;
  comparePercentage: string;
  compareRoundingType: string;
  compareRoundingCustom: string;
}

function emptyRange(): PriceRangeRow {
  return {
    min: "",
    max: "",
    formula: "C",
    roundingType: "none",
    roundingCustom: "",
    compareEnabled: false,
    compareBasis: "cost",
    compareType: "formula",
    compareFormula: "",
    compareFixedValue: "",
    comparePercentage: "",
    compareRoundingType: "none",
    compareRoundingCustom: "",
  };
}

function parseRanges(raw: unknown): PriceRangeRow[] {
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length === 0) return [];
    return arr.map((r: any) => ({
      min: r.min != null ? String(r.min) : "",
      max: r.max != null ? String(r.max) : "",
      formula: r.formula || "C",
      roundingType: r.roundingType || "none",
      roundingCustom: r.roundingCustom != null ? String(r.roundingCustom) : "",
      compareEnabled: !!r.compareEnabled,
      compareBasis: r.compareBasis || "cost",
      compareType: r.compareType || "formula",
      compareFormula: r.compareFormula || "",
      compareFixedValue: r.compareFixedValue != null ? String(r.compareFixedValue) : "",
      comparePercentage: r.comparePercentage != null ? String(r.comparePercentage) : "",
      compareRoundingType: r.compareRoundingType || "none",
      compareRoundingCustom: r.compareRoundingCustom != null ? String(r.compareRoundingCustom) : "",
    }));
  } catch {
    return [];
  }
}

function PriceRangeForm({
  ranges,
  onRangesChange,
  prefix,
}: {
  ranges: PriceRangeRow[];
  onRangesChange: (ranges: PriceRangeRow[]) => void;
  prefix: string;
}) {
  const { t } = useTranslation();
  const ROUNDING_OPTIONS = getRoundingOptions(t);
  const COMPARE_BASIS_OPTIONS = getCompareBasisOptions(t);
  const COMPARE_TYPE_OPTIONS = getCompareTypeOptions(t);

  const update = (idx: number, field: keyof PriceRangeRow, value: any) => {
    const next = ranges.map((r, i) => (i === idx ? { ...r, [field]: value } : r));
    onRangesChange(next);
  };

  const remove = (idx: number) => {
    onRangesChange(ranges.filter((_, i) => i !== idx));
  };

  const add = () => {
    onRangesChange([...ranges, emptyRange()]);
  };

  return (
    <BlockStack gap="400">
      {ranges.map((range, idx) => (
        <Card key={idx}>
          <BlockStack gap="300">
            <input type="hidden" name="rangeIndex" value={String(idx)} />
            <Text as="h3" variant="headingSm">
              {t("priceRules.formula")} {idx + 1}
            </Text>

            <FormLayout.Group>
              <TextField
                name={`${prefix}_${idx}_min`}
                label="Min (C)"
                value={range.min}
                onChange={(v) => update(idx, "min", v)}
                autoComplete="off"
                type="number"
              />
              <TextField
                name={`${prefix}_${idx}_max`}
                label="Max (C)"
                value={range.max}
                onChange={(v) => update(idx, "max", v)}
                autoComplete="off"
                type="number"
              />
              <TextField
                name={`${prefix}_${idx}_formula`}
                label={t("priceRules.formula")}
                value={range.formula}
                onChange={(v) => update(idx, "formula", v)}
                autoComplete="off"
                placeholder="C*1.262"
              />
              <Select
                name={`${prefix}_${idx}_roundingType`}
                label={t("priceRules.rounding")}
                value={range.roundingType}
                onChange={(v) => update(idx, "roundingType", v)}
                options={ROUNDING_OPTIONS}
              />
              <TextField
                name={`${prefix}_${idx}_roundingCustom`}
                label={t("priceRules.customRound")}
                value={range.roundingCustom}
                onChange={(v) => update(idx, "roundingCustom", v)}
                autoComplete="off"
                placeholder=".90"
              />
            </FormLayout.Group>

            <input
              type="hidden"
              name={`${prefix}_${idx}_compareEnabled`}
              value={range.compareEnabled ? "true" : ""}
            />
            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={range.compareEnabled}
                onChange={(e) => update(idx, "compareEnabled", e.target.checked)}
              />
              <Text as="span" variant="bodyMd">{t("priceRules.compareAt")}</Text>
            </label>

            {range.compareEnabled && (
              <FormLayout.Group>
                <Select
                  name={`${prefix}_${idx}_compareBasis`}
                  label={t("priceRules.compareAt")}
                  value={range.compareBasis}
                  onChange={(v) => update(idx, "compareBasis", v)}
                  options={COMPARE_BASIS_OPTIONS}
                />
                <Select
                  name={`${prefix}_${idx}_compareType`}
                  label={t("priceRules.compareType")}
                  value={range.compareType}
                  onChange={(v) => update(idx, "compareType", v)}
                  options={COMPARE_TYPE_OPTIONS}
                />
                {range.compareType === "formula" && (
                  <TextField
                    name={`${prefix}_${idx}_compareFormula`}
                    label={t("priceRules.compareFormulaLabel")}
                    value={range.compareFormula}
                    onChange={(v) => update(idx, "compareFormula", v)}
                    autoComplete="off"
                    placeholder="C*1.5"
                  />
                )}
                {range.compareType === "fixed" && (
                  <TextField
                    type="number"
                    name={`${prefix}_${idx}_compareFixedValue`}
                    label={t("priceRules.compareFixed")}
                    value={range.compareFixedValue}
                    onChange={(v) => update(idx, "compareFixedValue", v)}
                    autoComplete="off"
                    placeholder="10"
                  />
                )}
                {range.compareType === "percentage" && (
                  <TextField
                    type="number"
                    name={`${prefix}_${idx}_comparePercentage`}
                    label={t("priceRules.comparePercent")}
                    value={range.comparePercentage}
                    onChange={(v) => update(idx, "comparePercentage", v)}
                    autoComplete="off"
                    suffix="%"
                  />
                )}
                <Select
                  name={`${prefix}_${idx}_compareRoundingType`}
                  label={t("priceRules.compareRounding")}
                  value={range.compareRoundingType}
                  onChange={(v) => update(idx, "compareRoundingType", v)}
                  options={ROUNDING_OPTIONS}
                />
                <TextField
                  name={`${prefix}_${idx}_compareRoundingCustom`}
                  label={t("priceRules.compareRounding")}
                  value={range.compareRoundingCustom}
                  onChange={(v) => update(idx, "compareRoundingCustom", v)}
                  autoComplete="off"
                />
              </FormLayout.Group>
            )}

            {ranges.length > 1 && (
              <Button size="slim" tone="critical" onClick={() => remove(idx)}>
                {t("common.delete")}
              </Button>
            )}
          </BlockStack>
        </Card>
      ))}

      <Button variant="secondary" onClick={add}>
        {t("common.create")}
      </Button>
    </BlockStack>
  );
}

export default function PriceRules() {
  const { t } = useTranslation();
  const { rules, shopDomain, configId, usedCategories } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string; success?: boolean } | undefined;
  const { revalidate } = useRevalidator();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  useEffect(() => {
    if (actionData?.success) {
      revalidate();
      setName("");
      setRuleType("general");
      setTargetValues([]);
      setPriceFormula("C");
      setComparePriceFormula("");
      setComparePriceBasis("cost");
      setComparePriceType("formula");
      setComparePriceFixedValue("");
      setComparePricePercentage("");
      setCompareRoundingType("none");
      setCompareRoundingCustom("");
      setRoundingType("none");
      setRoundingCustom("");
      setUseRanges(false);
      setRanges([emptyRange()]);
    } else if (actionData?.error) {
      revalidate();
    }
  }, [actionData]);

  const [name, setName] = useState("");
  const [ruleType, setRuleType] = useState("general");
  const [targetValues, setTargetValues] = useState<string[]>([]);
  const [priceFormula, setPriceFormula] = useState("C");
  const [comparePriceFormula, setComparePriceFormula] = useState("");
  const [comparePriceBasis, setComparePriceBasis] = useState("cost");
  const [comparePriceType, setComparePriceType] = useState("formula");
  const [comparePriceFixedValue, setComparePriceFixedValue] = useState("");
  const [comparePricePercentage, setComparePricePercentage] = useState("");
  const [compareRoundingType, setCompareRoundingType] = useState("none");
  const [compareRoundingCustom, setCompareRoundingCustom] = useState("");
  const [roundingType, setRoundingType] = useState("none");
  const [roundingCustom, setRoundingCustom] = useState("");
  const [useRanges, setUseRanges] = useState(false);
  const [ranges, setRanges] = useState<PriceRangeRow[]>([emptyRange()]);

  const toggleTarget = useCallback((val: string) => {
    setTargetValues((prev) =>
      prev.includes(val) ? prev.filter((v) => v !== val) : [...prev, val]
    );
  }, []);

  const generalRules = rules.filter((r) => r.ruleType === "general");
  const categoryRules = rules.filter((r) => r.ruleType === "category");
  const productRules = rules.filter((r) => r.ruleType === "product");

  const showRanges = useRanges && ruleType !== "product";

  const ROUNDING_OPTIONS = getRoundingOptions(t);
  const RULE_TYPE_OPTIONS = getRuleTypeOptions(t);
  const COMPARE_BASIS_OPTIONS = getCompareBasisOptions(t);
  const COMPARE_TYPE_OPTIONS = getCompareTypeOptions(t);

  return (
    <BlockStack gap="400">
      {actionData?.error && (
          <Banner tone="critical" title={t("common.error")} onDismiss={() => {}}>
            {actionData.error}
          </Banner>
        )}
        {actionData?.success && (
          <Banner tone="success" title={t("import.saved")} />
        )}

        <div data-tutorial="price-rules-page">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              {t("priceRules.newRule")}
            </Text>
            <Form method="post" data-save-bar data-discard-confirmation>
              <FormLayout>
                <input type="hidden" name="shopDomain" value={shopDomain} />
                <input type="hidden" name="configId" value={configId} />
                <input type="hidden" name="intent" value="create" />
                <input type="hidden" name="useRanges" value={showRanges ? "on" : ""} />

                <FormLayout.Group>
                  <TextField
                    name="name"
                    label={t("common.name")}
                    value={name}
                    onChange={setName}
                    autoComplete="off"
                    placeholder={t("priceRules.ruleName")}
                  />
                  <Select
                    name="ruleType"
                    label={t("priceRules.compareType")}
                    value={ruleType}
                    onChange={(v) => {
                      setRuleType(v);
                      setTargetValues([]);
                      if (v === "product") {
                        setUseRanges(false);
                        setRanges([emptyRange()]);
                      }
                    }}
                    options={RULE_TYPE_OPTIONS}
                  />
                  <SearchableTargetPicker
                    ruleType={ruleType}
                    values={targetValues}
                    onToggle={toggleTarget}
                    shopDomain={shopDomain}
                    configId={configId}
                    disabledValues={ruleType === "category" ? usedCategories : []}
                  />
                </FormLayout.Group>

                {ruleType !== "product" && (
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={useRanges}
                      onChange={(e) => {
                        setUseRanges(e.target.checked);
                        if (!e.target.checked) setRanges([emptyRange()]);
                      }}
                    />
                    <Text as="span" variant="bodyMd">{t("tutorial.priceRanges")}</Text>
                  </label>
                )}

                {showRanges ? (
                  <PriceRangeForm ranges={ranges} onRangesChange={setRanges} prefix="range" />
                ) : (
                  <>
                    <FormLayout.Group>
                      <div data-tutorial="price-formula">
                      <TextField
                        name="priceFormula"
                        label={t("priceRules.formula")}
                        value={priceFormula}
                        onChange={setPriceFormula}
                        autoComplete="off"
                        placeholder="C*1.262"
                      />
                      </div>
                      <div data-tutorial="price-rounding">
                      <Select
                        name="roundingType"
                        label={t("priceRules.rounding")}
                        value={roundingType}
                        onChange={setRoundingType}
                        options={ROUNDING_OPTIONS}
                      />
                      </div>
                      <TextField
                        name="roundingCustom"
                        label={t("priceRules.customRound")}
                        value={roundingCustom}
                        onChange={setRoundingCustom}
                        autoComplete="off"
                        placeholder=".90"
                      />
                    </FormLayout.Group>

                    <div data-tutorial="price-compare">
                    <FormLayout.Group>
                      <Select
                        name="comparePriceBasis"
                        label={t("priceRules.compareAt")}
                        value={comparePriceBasis}
                        onChange={setComparePriceBasis}
                        options={COMPARE_BASIS_OPTIONS}
                      />
                      <Select
                        name="comparePriceType"
                        label={t("priceRules.compareType")}
                        value={comparePriceType}
                        onChange={setComparePriceType}
                        options={COMPARE_TYPE_OPTIONS}
                      />
                      {comparePriceType === "formula" && (
                        <TextField
                          name="comparePriceFormula"
                          label={t("priceRules.compareFormulaLabel")}
                          value={comparePriceFormula}
                          onChange={setComparePriceFormula}
                          autoComplete="off"
                          placeholder="C*1.5"
                          helpText={t("priceRules.formulaHelp")}
                        />
                      )}
                      {comparePriceType === "fixed" && (
                        <TextField
                          type="number"
                          name="comparePriceFixedValue"
                          label={t("priceRules.compareFixed")}
                          value={comparePriceFixedValue}
                          onChange={setComparePriceFixedValue}
                          autoComplete="off"
                          placeholder="10"
                          helpText={t("priceRules.formulaHelp")}
                        />
                      )}
                      {comparePriceType === "percentage" && (
                        <TextField
                          type="number"
                          name="comparePricePercentage"
                          label={t("priceRules.comparePercent")}
                          value={comparePricePercentage}
                          onChange={setComparePricePercentage}
                          autoComplete="off"
                          placeholder="20"
                          suffix="%"
                          helpText={t("priceRules.formulaHelp")}
                        />
                      )}
                    </FormLayout.Group>
                    </div>

                    <FormLayout.Group>
                      <Select
                        name="compareRoundingType"
                        label={t("priceRules.compareRounding")}
                        value={compareRoundingType}
                        onChange={setCompareRoundingType}
                        options={ROUNDING_OPTIONS}
                      />
                      <TextField
                        name="compareRoundingCustom"
                        label={t("priceRules.compareRounding")}
                        value={compareRoundingCustom}
                        onChange={setCompareRoundingCustom}
                        autoComplete="off"
                        placeholder=".90"
                      />
                    </FormLayout.Group>
                  </>
                )}

                <Button submit variant="primary" disabled={isSubmitting}>
                  {isSubmitting ? t("common.saving") : t("priceRules.createRule")}
                </Button>
              </FormLayout>
            </Form>
          </BlockStack>
        </Card>
        </div>

        <RuleSection
          title={t("priceRules.generalRule")}
          rules={generalRules}
          shopDomain={shopDomain}
          configId={configId}
          actionSuccess={actionData?.success}
        />
        <RuleSection
          title={t("priceRules.byCategory")}
          rules={categoryRules}
          shopDomain={shopDomain}
          configId={configId}
          actionSuccess={actionData?.success}
        />
        <RuleSection
          title={t("priceRules.bySku")}
          rules={productRules}
          shopDomain={shopDomain}
          configId={configId}
          actionSuccess={actionData?.success}
        />
      </BlockStack>
  );
}

function RuleSection({
  title,
  rules,
  shopDomain,
  configId,
  actionSuccess,
}: {
  title: string;
  rules: any[];
  shopDomain: string;
  configId: string;
  actionSuccess?: boolean;
}) {
  const { t } = useTranslation();
  const [editingRule, setEditingRule] = useState<any>(null);
  const [previewRule, setPreviewRule] = useState<any>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<any>(null);

  useEffect(() => {
    if (actionSuccess) {
      setEditingRule(null);
      setDeleteConfirm(null);
    }
  }, [actionSuccess]);

  if (rules.length === 0) return null;

  const rows = rules.map((rule) => {
    const hasRanges = !!rule.priceRanges;
    let ranges: any[] = [];
    if (hasRanges) {
      try {
        const parsed = typeof rule.priceRanges === "string" ? JSON.parse(rule.priceRanges) : rule.priceRanges;
        ranges = Array.isArray(parsed) ? parsed : [];
      } catch { ranges = []; }
    }

    let formulaDisplay: React.ReactNode;
    let compDisplay: React.ReactNode;
    let roundingDisplay: React.ReactNode;

    if (hasRanges && ranges.length > 0) {
      const first = ranges[0];
      const uniqueFormulas = [...new Set(ranges.map((r) => r.formula))];
      formulaDisplay = (
        <div key={`f-${rule.id}`}>
          <Badge tone="attention">{`${ranges.length} ${t("priceRules.formula")}${ranges.length > 1 ? "s" : ""}`}</Badge>
          <div style={{ marginTop: 4 }}>
            <code>{uniqueFormulas.length === 1 ? uniqueFormulas[0] : `${uniqueFormulas.length} ${t("priceRules.formula")}`}</code>
          </div>
        </div>
      );

      const cmpRounding = first.compareRoundingType === "custom" && first.compareRoundingCustom != null
        ? ` (${t("priceRules.rounding")}: ${first.compareRoundingCustom})`
        : first.compareRoundingType !== "none" ? ` (${t("priceRules.rounding")}: ${first.compareRoundingType})` : "";

      if (first.compareEnabled) {
        const basisLabel = first.compareBasis === "regular" ? "X" : "C";
        if (first.compareType === "formula") {
          compDisplay = <code key={`c-${rule.id}`}>{basisLabel}: {first.compareFormula}{cmpRounding}</code>;
        } else if (first.compareType === "fixed") {
          compDisplay = <code key={`c-${rule.id}`}>{t("priceRules.compareFixed")}: {first.compareFixedValue}{cmpRounding}</code>;
        } else {
          compDisplay = <code key={`c-${rule.id}`}>%{first.comparePercentage} {t("priceRules.compareAt")} {basisLabel}{cmpRounding}</code>;
        }
      } else {
        compDisplay = "---";
      }

      roundingDisplay = first.roundingType === "custom" && first.roundingCustom
        ? `${t("priceRules.customRound")} (${first.roundingCustom})`
        : first.roundingType;
    } else {
      formulaDisplay = <code key={`f-${rule.id}`}>{rule.priceFormula}</code>;

      const basisLabel = rule.comparePriceBasis === "regular" ? "X" : "C";
      if (rule.comparePriceEnabled) {
        const cmpRounding = rule.compareRoundingType === "custom" && rule.compareRoundingCustom != null
          ? ` (${t("priceRules.rounding")}: ${rule.compareRoundingCustom})`
          : rule.compareRoundingType !== "none" ? ` (${t("priceRules.rounding")}: ${rule.compareRoundingType})` : "";
        if (rule.comparePriceType === "formula") {
          compDisplay = <code key={`c-${rule.id}`}>{basisLabel}: {rule.comparePriceFormula}{cmpRounding}</code>;
        } else if (rule.comparePriceType === "fixed") {
          compDisplay = <code key={`c-${rule.id}`}>{t("priceRules.compareFixed")}: {rule.comparePriceFixedValue}{cmpRounding}</code>;
        } else {
          compDisplay = <code key={`c-${rule.id}`}>%{rule.comparePricePercentage} {t("priceRules.compareAt")} {basisLabel}{cmpRounding}</code>;
        }
      } else {
        compDisplay = "---";
      }

      roundingDisplay = rule.roundingType === "custom" && rule.roundingCustom != null
        ? `${t("priceRules.customRound")} (${rule.roundingCustom})`
        : rule.roundingType;
    }

    return [
      rule.name,
      formulaDisplay,
      compDisplay,
      roundingDisplay,
      <Form key={`t-${rule.id}`} method="post" style={{ display: "inline" }}>
        <input type="hidden" name="shopDomain" value={shopDomain} />
        <input type="hidden" name="configId" value={configId} />
        <input type="hidden" name="intent" value="toggle" />
        <input type="hidden" name="ruleId" value={rule.id} />
        <Button submit variant={rule.isActive ? "primary" : "secondary"} size="slim">
          {rule.isActive ? t("priceRules.yes") : t("priceRules.no")}
        </Button>
      </Form>,
      <span key={`a-${rule.id}`} style={{ display: "inline-flex", gap: "4px" }}>
        <Button key={`p-${rule.id}`} size="slim" icon={ViewIcon} onClick={() => setPreviewRule(rule)}>
          {t("common.view")}
        </Button>
        <Button key={`e-${rule.id}`} size="slim" onClick={() => setEditingRule(rule)}>
          {t("common.edit")}
        </Button>
        <Button key={`d-${rule.id}`} size="slim" variant="primary" tone="critical" onClick={() => setDeleteConfirm(rule)}>
          {t("common.delete")}
        </Button>
      </span>,
    ];
  });

  return (
    <div data-tutorial="price-existing">
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="headingMd">
          {title}
        </Text>
        <DataTable
          columnContentTypes={["text", "text", "text", "text", "text"]}
          headings={[t("common.name"), t("priceRules.formula"), t("priceRules.compareType"), t("priceRules.rounding"), t("priceRules.active"), t("common.actions")]}
          rows={rows}
        />
      </BlockStack>
      {editingRule && (
        <EditRuleModal
          rule={editingRule}
          shopDomain={shopDomain}
          configId={configId}
          onClose={() => setEditingRule(null)}
          actionSuccess={actionSuccess}
        />
      )}
      {previewRule && (
        <Modal
          open
          onClose={() => setPreviewRule(null)}
          title={`${t("common.view")}: ${previewRule.name}`}
          secondaryActions={[{ content: t("common.close"), onAction: () => setPreviewRule(null) }]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" variant="bodyMd" fontWeight="semibold">{t("priceRules.compareType")}:</Text>
                <Badge>{previewRule.ruleType === "general" ? t("priceRules.general") : previewRule.ruleType === "category" ? t("priceRules.byCategory") : t("priceRules.bySku")}</Badge>
                <Badge tone={previewRule.isActive ? "success" : "critical"}>{previewRule.isActive ? t("priceRules.active") : t("common.inactive")}</Badge>
              </InlineStack>

              {previewRule.targetValue && (
                <BlockStack gap="100">
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {previewRule.ruleType === "category" ? `${t("common.category")}:` : `${t("common.sku")}:`}
                  </Text>
                  <Text as="p" variant="bodySm">
                    {(() => {
                      try {
                        const targets: string[] = JSON.parse(previewRule.targetValue);
                        return targets.join(", ");
                      } catch { return "—"; }
                    })()}
                  </Text>
                </BlockStack>
              )}

              {previewRule.priceRanges ? (
                <BlockStack gap="200">
                  <Text as="span" variant="bodyMd" fontWeight="semibold">{t("priceRules.formula")}:</Text>
                  {(() => {
                    try {
                      const ranges: any[] = JSON.parse(previewRule.priceRanges);
                      return ranges.map((r, i) => (
                        <Card key={i}>
                          <InlineStack gap="300" blockAlign="center">
                            <Badge>{`${t("priceRules.formula")} ${i + 1}`}</Badge>
                            <Text as="span" variant="bodySm">
                              {r.min && r.max ? `C: ${r.min} – ${r.max}` : r.min ? `C ≥ ${r.min}` : r.max ? `C ≤ ${r.max}` : "—"}
                            </Text>
                            <Text as="span" variant="bodySm" fontWeight="semibold">
                              {t("priceRules.formula")}: {r.formula}
                            </Text>
                            {r.roundingType !== "none" && (
                              <Text as="span" variant="bodySm" tone="subdued">
                                {t("priceRules.rounding")}: {r.roundingType === "custom" ? r.roundingCustom : r.roundingType}
                              </Text>
                            )}
                            {r.compareEnabled && (
                              <Badge tone="attention">
                                {`${t("priceRules.compareType")}: ${r.compareBasis === "regular" ? "X" : "C"} ${r.compareType === "formula" ? r.compareFormula : r.compareType === "fixed" ? `+${r.compareFixedValue}` : `${r.comparePercentage}%`}`}
                              </Badge>
                            )}
                          </InlineStack>
                        </Card>
                      ));
                    } catch { return <Text as="p" tone="subdued">{t("common.error")}</Text>; }
                  })()}
                </BlockStack>
              ) : (
                <BlockStack gap="100">
                  <Text as="span" variant="bodyMd" fontWeight="semibold">{t("priceRules.formula")}:</Text>
                  <Card>
                    <Text as="p" variant="bodyMd">
                      {previewRule.priceFormula}
                      {previewRule.roundingType !== "none" && (
                        <Text as="span" tone="subdued"> — {t("priceRules.rounding")}: {previewRule.roundingType === "custom" ? previewRule.roundingCustom : previewRule.roundingType}</Text>
                      )}
                    </Text>
                  </Card>
                </BlockStack>
              )}

              {previewRule.comparePriceEnabled && (
                <BlockStack gap="100">
                  <Text as="span" variant="bodyMd" fontWeight="semibold">{t("priceRules.compareFormulaLabel")}:</Text>
                  <Card>
                    <Text as="p" variant="bodyMd">
                      {t("priceRules.compareAt")}: {previewRule.comparePriceBasis === "regular" ? t("priceRules.compareX") : t("priceRules.compareC")}
                      {" — "}
                      {previewRule.comparePriceType === "formula" && `${t("priceRules.formula")}: ${previewRule.comparePriceFormula}`}
                      {previewRule.comparePriceType === "fixed" && `+${previewRule.comparePriceFixedValue}`}
                      {previewRule.comparePriceType === "percentage" && `${previewRule.comparePricePercentage}%`}
                      {previewRule.compareRoundingType !== "none" && (
                        <Text as="span" tone="subdued"> — {t("priceRules.rounding")}: {previewRule.compareRoundingType === "custom" ? previewRule.compareRoundingCustom : previewRule.compareRoundingType}</Text>
                      )}
                    </Text>
                  </Card>
                </BlockStack>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
      {deleteConfirm && (
        <Modal
          open
          onClose={() => setDeleteConfirm(null)}
          title={t("common.delete")}
          primaryAction={{
            content: t("common.delete"),
            onAction: () => {
              const form = new FormData();
              form.set("shopDomain", shopDomain);
              form.set("configId", configId);
              form.set("intent", "delete");
              form.set("ruleId", deleteConfirm.id);
              fetch(window.location.href, { method: "POST", body: form });
              setDeleteConfirm(null);
            },
            destructive: true,
          }}
          secondaryActions={[{ content: t("common.cancel"), onAction: () => setDeleteConfirm(null) }]}
        >
          <Modal.Section>
            <Text as="p">
              {t("common.delete")} <strong>{deleteConfirm.name}</strong>? {t("common.delete")}
            </Text>
          </Modal.Section>
        </Modal>
      )}
    </Card>
    </div>
  );
}

function EditRuleModal({
  rule,
  shopDomain,
  configId,
  onClose,
  actionSuccess,
}: {
  rule: any;
  shopDomain: string;
  configId: string;
  onClose: () => void;
  actionSuccess?: boolean;
}) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  useEffect(() => {
    if (actionSuccess) onClose();
  }, [actionSuccess, onClose]);
  const parsedRanges = parseRanges(rule.priceRanges);
  const [name, setName] = useState(rule.name);
  const [ruleType, setRuleType] = useState(rule.ruleType);
  const [targetValues, setTargetValues] = useState<string[]>(
    rule.targetValue ? JSON.parse(rule.targetValue) : []
  );
  const [priceFormula, setPriceFormula] = useState(rule.priceFormula);
  const [comparePriceBasis, setComparePriceBasis] = useState(rule.comparePriceBasis);
  const [comparePriceType, setComparePriceType] = useState(rule.comparePriceType);
  const [comparePriceFormula, setComparePriceFormula] = useState(rule.comparePriceFormula || "");
  const [comparePriceFixedValue, setComparePriceFixedValue] = useState(
    rule.comparePriceFixedValue != null ? String(rule.comparePriceFixedValue) : ""
  );
  const [comparePricePercentage, setComparePricePercentage] = useState(
    rule.comparePricePercentage != null ? String(rule.comparePricePercentage) : ""
  );
  const [compareRoundingType, setCompareRoundingType] = useState(rule.compareRoundingType);
  const [compareRoundingCustom, setCompareRoundingCustom] = useState(
    rule.compareRoundingCustom != null ? String(rule.compareRoundingCustom) : ""
  );
  const [roundingType, setRoundingType] = useState(rule.roundingType);
  const [roundingCustom, setRoundingCustom] = useState(
    rule.roundingCustom != null ? String(rule.roundingCustom) : ""
  );
  const [useRanges, setUseRanges] = useState(parsedRanges.length > 0);
  const [ranges, setRanges] = useState<PriceRangeRow[]>(
    parsedRanges.length > 0 ? parsedRanges : [emptyRange()]
  );

  const toggleTarget = useCallback((val: string) => {
    setTargetValues((prev) =>
      prev.includes(val) ? prev.filter((v) => v !== val) : [...prev, val]
    );
  }, []);

  const showRanges = useRanges && ruleType !== "product";

  const ROUNDING_OPTIONS = getRoundingOptions(t);
  const RULE_TYPE_OPTIONS = getRuleTypeOptions(t);
  const COMPARE_BASIS_OPTIONS = getCompareBasisOptions(t);
  const COMPARE_TYPE_OPTIONS = getCompareTypeOptions(t);

  return (
    <Modal
      open
      onClose={onClose}
      title={`${t("common.edit")}: ${rule.name}`}
      primaryAction={{
        content: isSubmitting ? t("common.saving") : t("common.save"),
        onAction: () => {
          const form = document.getElementById(`edit-rule-form-${rule.id}`) as HTMLFormElement;
          if (form) form.requestSubmit();
        },
        disabled: isSubmitting,
      }}
      secondaryActions={[{ content: t("common.cancel"), onAction: onClose }]}
    >
      <Modal.Section>
        <Form id={`edit-rule-form-${rule.id}`} method="post">
          <input type="hidden" name="shopDomain" value={shopDomain} />
          <input type="hidden" name="configId" value={configId} />
          <input type="hidden" name="intent" value="update" />
          <input type="hidden" name="ruleId" value={rule.id} />
          <input type="hidden" name="useRanges" value={showRanges ? "on" : ""} />
          {targetValues.map((v, i) => (
            <input key={`tv-${i}`} type="hidden" name="targetValue" value={v} />
          ))}
          <FormLayout>
            <FormLayout.Group>
              <TextField name="name" label={t("common.name")} value={name} onChange={setName} autoComplete="off" />
              <Select
                name="ruleType"
                label={t("priceRules.compareType")}
                value={ruleType}
                onChange={(v) => {
                  setRuleType(v);
                  setTargetValues([]);
                  if (v === "product") {
                    setUseRanges(false);
                    setRanges([emptyRange()]);
                  }
                }}
                options={RULE_TYPE_OPTIONS}
              />
            </FormLayout.Group>

            {ruleType !== "general" && (
              <SearchableTargetPicker
                ruleType={ruleType}
                values={targetValues}
                onToggle={toggleTarget}
                shopDomain={shopDomain}
                configId={configId}
              />
            )}

            {ruleType !== "product" && (
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={useRanges}
                  onChange={(e) => {
                    setUseRanges(e.target.checked);
                    if (!e.target.checked) setRanges([emptyRange()]);
                  }}
                />
                <Text as="span" variant="bodyMd">{t("tutorial.priceRanges")}</Text>
              </label>
            )}

            {showRanges ? (
              <PriceRangeForm ranges={ranges} onRangesChange={setRanges} prefix="range" />
            ) : (
              <>
                <FormLayout.Group>
                  <TextField name="priceFormula" label={t("priceRules.formula")} value={priceFormula} onChange={setPriceFormula} autoComplete="off" />
                  <Select name="roundingType" label={t("priceRules.rounding")} value={roundingType} onChange={setRoundingType} options={ROUNDING_OPTIONS} />
                  <TextField name="roundingCustom" label={t("priceRules.customRound")} value={roundingCustom} onChange={setRoundingCustom} autoComplete="off" />
                </FormLayout.Group>

                <FormLayout.Group>
                  <Select name="comparePriceBasis" label={t("priceRules.compareAt")} value={comparePriceBasis} onChange={setComparePriceBasis} options={COMPARE_BASIS_OPTIONS} />
                  <Select name="comparePriceType" label={t("priceRules.compareType")} value={comparePriceType} onChange={setComparePriceType} options={COMPARE_TYPE_OPTIONS} />
                  {comparePriceType === "formula" && (
                    <TextField name="comparePriceFormula" label={t("priceRules.compareFormulaLabel")} value={comparePriceFormula} onChange={setComparePriceFormula} autoComplete="off" />
                  )}
                  {comparePriceType === "fixed" && (
                    <TextField type="number" name="comparePriceFixedValue" label={t("priceRules.compareFixed")} value={comparePriceFixedValue} onChange={setComparePriceFixedValue} autoComplete="off" />
                  )}
                  {comparePriceType === "percentage" && (
                    <TextField type="number" name="comparePricePercentage" label={t("priceRules.comparePercent")} value={comparePricePercentage} onChange={setComparePricePercentage} autoComplete="off" suffix="%" />
                  )}
                </FormLayout.Group>

                <FormLayout.Group>
                  <Select name="compareRoundingType" label={t("priceRules.compareRounding")} value={compareRoundingType} onChange={setCompareRoundingType} options={ROUNDING_OPTIONS} />
                  <TextField name="compareRoundingCustom" label={t("priceRules.compareRounding")} value={compareRoundingCustom} onChange={setCompareRoundingCustom} autoComplete="off" />
                </FormLayout.Group>
              </>
            )}
          </FormLayout>
        </Form>
      </Modal.Section>
    </Modal>
  );
}
