import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data } from "react-router";

import { useLoaderData, useActionData, Form } from "react-router";
import { useState, useEffect } from "react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  FormLayout,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { prisma, getConfigById, getEffectiveUrl, getSourceKey } from "~/lib/db.server";
import { authenticate } from "~/shopify.server";
import { fetchCSVHeaders } from "~/lib/csv-parser.server";
import { getCachedHeaders } from "~/lib/csv-cache.server";
import { useTranslation } from "react-i18next";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configId = params.id as string;

  const config = await getConfigById(configId);
  if (!config || config.shopDomain !== shopDomain) throw new Response("Not found", { status: 404 });

  const sourceKey = getSourceKey(config);

  let mappings = await prisma.columnMapping.findMany({
    where: { configId: config.id, sourceKey },
  });

  if (mappings.length === 0) {
    let csvHeaders: string[] = [];
    try {
      const url = getEffectiveUrl(config);
      if (url) csvHeaders = await getCachedHeaders(config.id, url, config.csvDelimiter || "auto");
    } catch {}
    const headerSet = new Set(csvHeaders);

    const defaults = SHOP_FIELDS.map((f) => ({
      configId: config.id,
      shopDomain,
      sourceKey,
      shopifyField: f.value,
      csvColumn: headerSet.has(f.value) ? f.value : null,
      defaultValue: null,
    }));

    for (const d of defaults) {
      await prisma.columnMapping.upsert({
        where: { configId_sourceKey_shopifyField: { configId: d.configId, sourceKey: d.sourceKey, shopifyField: d.shopifyField } },
        create: d,
        update: {},
      }).catch(() => {});
    }

    mappings = await prisma.columnMapping.findMany({ where: { configId: config.id, sourceKey } });
  }

  return data({ mappings, shopDomain, csvUrl: getEffectiveUrl(config), configId: config.id });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configId = params.id as string;

  const formData = await request.formData();

  const config = await getConfigById(configId);
  if (!config || config.shopDomain !== shopDomain) throw new Response("Not found", { status: 404 });

  const sourceKey = getSourceKey(config);

  const updates: Array<{ shopifyField: string; csvColumn: string | null; defaultValue: string | null }> = [];

  for (const field of SHOP_FIELDS) {
    const csvCol = formData.get(`csv_${field.value}`) as string;
    const defaultVal = formData.get(`default_${field.value}`) as string;
    updates.push({
      shopifyField: field.value,
      csvColumn: csvCol ? csvCol.toLowerCase() : null,
      defaultValue: defaultVal || null,
    });
  }

  await prisma.columnMapping.deleteMany({ where: { configId: config.id, sourceKey } });
  await prisma.columnMapping.createMany({
    data: updates.map((u) => ({ ...u, configId: config.id, shopDomain, sourceKey })),
  });

  return data({ success: true });
};

const SHOP_FIELDS = [
  { value: "title", labelKey: "columns.fieldTitle" },
  { value: "description", labelKey: "columns.fieldDescription" },
  { value: "short_description", labelKey: "columns.fieldShortDesc" },
  { value: "sku", labelKey: "columns.fieldSku" },
  { value: "ean", labelKey: "columns.fieldEan" },
  { value: "price", labelKey: "columns.fieldPrice" },
  { value: "quantity", labelKey: "columns.fieldQuantity" },
  { value: "category", labelKey: "columns.fieldCategory" },
  { value: "brand", labelKey: "columns.fieldBrand" },
  { value: "tipo_producto", labelKey: "columns.fieldProductType" },
  { value: "weight", labelKey: "columns.fieldWeight" },
  { value: "image1", labelKey: "columns.fieldImage1" },
  { value: "image2", labelKey: "columns.fieldImage2" },
  { value: "image3", labelKey: "columns.fieldImage3" },
  { value: "image4", labelKey: "columns.fieldImage4" },
  { value: "image5", labelKey: "columns.fieldImage5" },
];

export default function Columns() {
  const { t } = useTranslation();
  const { mappings, shopDomain, csvUrl, configId } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string; success?: boolean } | undefined;

  const [csvColumns, setCsvColumns] = useState<string[]>([]);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [loadingHeaders, setLoadingHeaders] = useState(!!csvUrl);

  useEffect(() => {
    if (!csvUrl) {
      setLoadingHeaders(false);
      return;
    }
    const loadHeaders = async () => {
      try {
        const params = new URLSearchParams({ shop: shopDomain, configId, type: "headers" });
        const res = await fetch(`/api/csv-options?${params}`);
        const d = await res.json();
        if (d.headers?.length > 0) {
          setCsvColumns(d.headers);
          setHeaderError(null);
        } else if (d.error) {
          setHeaderError(d.error);
        }
      } catch (e: any) {
        setHeaderError(e.message);
      } finally {
        setLoadingHeaders(false);
      }
    };
    loadHeaders();
  }, [shopDomain, configId, csvUrl]);

  const [csvCols, setCsvCols] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const m of mappings) map[m.shopifyField] = (m.csvColumn || "").toLowerCase();
    return map;
  });
  const [defaults, setDefaults] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const m of mappings) map[m.shopifyField] = m.defaultValue || "";
    return map;
  });

  useEffect(() => {
    if (csvColumns.length === 0) return;
    const colSet = new Set(csvColumns);
    setCsvCols((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [key, val] of Object.entries(next)) {
        if (val && !colSet.has(val)) {
          next[key] = "";
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [csvColumns]);

  const shopFields = SHOP_FIELDS.map((f) => ({ ...f, label: t(f.labelKey) }));

  return (
    <>
      {actionData?.success && (
        <Banner tone="success" title={t("columns.saved")} />
      )}
      {actionData?.error && (
        <Banner tone="critical" title={t("columns.error")} onDismiss={() => {}}>
          {actionData.error}
        </Banner>
      )}

      {!csvUrl ? (
        <Banner tone="warning" title={t("columns.noFile")}>
          {t("columns.noFileMessage")}
        </Banner>
      ) : loadingHeaders ? (
        <Banner tone="info">{t("columns.loadingHeaders")}</Banner>
      ) : headerError ? (
        <Banner tone="warning" title={t("columns.headersError")}>
          {headerError}. {t("columns.headersFallback")}
        </Banner>
      ) : (
        <Banner tone="info">
          {t("columns.detectedColumns")} <strong>{csvColumns.length}</strong> (
          {csvUrl.split("/").pop()}). {t("columns.headersInfo")}
        </Banner>
      )}

      <Form method="post" data-save-bar data-discard-confirmation>
        <BlockStack gap="300">
          <div data-tutorial="columns-page">
          <Card>
            <FormLayout>
              {shopFields.map((field) => (
                <FormLayout.Group key={field.value}>
                  <InlineStack gap="400" blockAlign="center">
                    <div style={{ width: "260px" }}>
                      <Text as="span" fontWeight="semibold">
                        {field.label}
                      </Text>
                    </div>
                  </InlineStack>
                    <div {...(field.value === "title" ? { "data-tutorial": "column-select-example" } : {})}>
                    <Select
                      name={`csv_${field.value}`}
                      label={t("columns.columnFile")}
                      labelHidden
                      value={csvCols[field.value] || ""}
                      onChange={(value) => setCsvCols((prev) => ({ ...prev, [field.value]: value }))}
                      options={
                        csvColumns.length > 0
                          ? [
                              { label: t("columns.noMapping"), value: "" },
                              ...csvColumns.map((col) => ({ label: col, value: col })),
                            ]
                          : [{ label: t("columns.noFileAvailable"), value: "" }]
                      }
                    />
                    </div>
                    <div {...(field.value === "title" ? { "data-tutorial": "column-default-example" } : {})}>
                    <TextField
                      name={`default_${field.value}`}
                      label={t("columns.defaultValue")}
                      labelHidden
                      placeholder={t("columns.noDefault")}
                      value={defaults[field.value] || ""}
                      onChange={(value) => setDefaults((prev) => ({ ...prev, [field.value]: value }))}
                      autoComplete="off"
                    />
                    </div>
                </FormLayout.Group>
              ))}
            </FormLayout>
          </Card>
          </div>

          {/* Botón "Guardar Mapeo" oculto — data-save-bar lo reemplaza.
              Descomentar si se necesita restaurar el botón clásico: */}
          {/*
          <Button submit variant="primary">
            Guardar Mapeo
          </Button>
          */}
        </BlockStack>
      </Form>
    </>
  );
}
