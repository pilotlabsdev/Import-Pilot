import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data, useLoaderData, useFetcher, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  EmptyState,
  DataTable,
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";

import { authenticate } from "~/shopify.server";
import { prisma } from "~/lib/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const duplicates = await prisma.duplicateLog.findMany({
    where: { shopDomain },
    orderBy: { detectedAt: "desc" },
  });

  // Resolve supplier names from ImportConfig by ID (stored names may be stale)
  const allConfigIds = new Set<string>();
  for (const d of duplicates) {
    if (d.supplierA_id && d.supplierA_id !== "EXTERNAL") allConfigIds.add(d.supplierA_id);
    if (d.supplierB_id) allConfigIds.add(d.supplierB_id);
  }

  const configs = await prisma.importConfig.findMany({
    where: { id: { in: [...allConfigIds] } },
    select: { id: true, name: true },
  });
  const configMap = new Map(configs.map((c) => [c.id, c.name]));

  // Resolve SKUs from ProductMapping for logs with empty SKUs
  const skusToResolve = duplicates.filter((d) => !d.supplierA_sku || !d.supplierB_sku);
  const skuMap = new Map<string, string>();
  if (skusToResolve.length > 0) {
    const eanConfigPairs = skusToResolve.map((d) => ({
      ean: d.ean,
      configId: d.supplierA_id !== "EXTERNAL" ? d.supplierA_id : d.supplierB_id,
      isA: d.supplierA_id !== "EXTERNAL" && !d.supplierA_sku,
      isB: !d.supplierB_sku,
    }));

    const uniqueEans = [...new Set(skusToResolve.map((d) => d.ean))];
    const uniqueConfigIds = [...new Set(eanConfigPairs.map((p) => p.configId))];

    const mappings = await prisma.productMapping.findMany({
      where: {
        shopDomain,
        ean: { in: uniqueEans },
        configId: { in: uniqueConfigIds },
      },
      select: { ean: true, configId: true, supplierSku: true },
    });

    for (const m of mappings) {
      skuMap.set(`${m.ean}:${m.configId}`, m.supplierSku);
    }
  }

  const resolved = duplicates.map((d) => {
    const aSku = d.supplierA_sku || skuMap.get(`${d.ean}:${d.supplierA_id}`) || "";
    const bSku = d.supplierB_sku || skuMap.get(`${d.ean}:${d.supplierB_id}`) || "";
    return {
      ...d,
      supplierA_name:
        d.supplierA_id === "EXTERNAL"
          ? "Ya creado en Shopify"
          : configMap.get(d.supplierA_id) || d.supplierA_name,
      supplierA_sku: aSku,
      supplierB_name: configMap.get(d.supplierB_id) || d.supplierB_name,
      supplierB_sku: bSku,
    };
  });

  const unresolvedCount = resolved.filter((d) => !d.resolved).length;

  return data({ duplicates: resolved, unresolvedCount });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "resolve") {
    const id = form.get("id") as string;
    await prisma.duplicateLog.update({
      where: { id },
      data: { resolved: true },
    });
    return data({ success: true });
  }

  if (intent === "resolveAll") {
    const shopDomain = session.shop;
    await prisma.duplicateLog.updateMany({
      where: { shopDomain, resolved: false },
      data: { resolved: true },
    });
    return data({ success: true });
  }

  if (intent === "unresolve") {
    const id = form.get("id") as string;
    await prisma.duplicateLog.update({
      where: { id },
      data: { resolved: false },
    });
    return data({ success: true });
  }

  return data({ error: "Intento no válido" }, { status: 400 });
};

export default function Duplicates() {
  const { duplicates, unresolvedCount } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const rows = duplicates.map((d) => [
    <Text key="ean" variant="bodyMd" as="p" fontWeight="semibold">
      {d.ean}
    </Text>,
    <BlockStack key="a" gap="0">
      <Text variant="bodyMd" as="p">{d.supplierA_name}</Text>
      <Text variant="bodySm" as="p" tone="subdued">
        SKU: {d.supplierA_sku}
      </Text>
    </BlockStack>,
    <BlockStack key="b" gap="0">
      <Text variant="bodyMd" as="p">{d.supplierB_name}</Text>
      <Text variant="bodySm" as="p" tone="subdued">
        SKU: {d.supplierB_sku}
      </Text>
    </BlockStack>,
    <Text key="date" variant="bodySm" as="p" tone="subdued">
      {new Date(d.detectedAt).toLocaleDateString("es-ES")}
    </Text>,
    d.resolved ? (
      <Button
        key="unresolve"
        size="slim"
        variant="tertiary"
        onClick={() =>
          fetcher.submit(
            { intent: "unresolve", id: d.id },
            { method: "POST" }
          )
        }
      >
        {t("duplicates.undo")}
      </Button>
    ) : (
      <Button
        key="resolve"
        size="slim"
        onClick={() =>
          fetcher.submit(
            { intent: "resolve", id: d.id },
            { method: "POST" }
          )
        }
      >
        {t("duplicates.markResolved")}
      </Button>
    ),
  ]);

  return (
    <Page
      title={t("duplicates.title")}
      titleMetadata={<span data-tutorial="duplicates-page" aria-hidden />}
      backAction={{ content: t("nav.dashboard"), onAction: () => navigate("/app") }}
      primaryAction={
        unresolvedCount > 0
          ? {
              content: t("duplicates.markAllResolved", { count: unresolvedCount }),
              onAction: () =>
                fetcher.submit(
                  { intent: "resolveAll" },
                  { method: "POST" }
                ),
            }
          : undefined
      }
    >
      <Layout>
        <Layout.Section>
          <div data-tutorial="duplicates-table">
          <Card>
            {duplicates.length === 0 ? (
              <EmptyState
                heading={t("duplicates.noDuplicates")}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  {t("duplicates.noDuplicatesMessage")}
                </p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={[t("common.ean"), t("duplicates.supplierA"), t("duplicates.supplierB"), t("duplicates.detected"), t("common.status")]}
                rows={rows}
              />
            )}
          </Card>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
