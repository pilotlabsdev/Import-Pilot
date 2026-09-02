import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useFetcher, useRevalidator } from "react-router";
import { useEffect, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  DataTable,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { useTranslation } from "react-i18next";

const STATUS_TONE: Record<string, "success" | "critical" | "attention" | "info" | "warning"> = {
  completed: "success",
  failed: "critical",
  cancelled: "warning",
  running: "attention",
  queued: "info",
  completed_with_errors: "attention",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    console.log(`[Queue Page] Loader OK, shop=${session.shop}`);
    return data({ shopDomain: session.shop });
  } catch (error: any) {
    console.error(`[Queue Page] Loader FAILED:`, error?.message || error);
    throw error;
  }
};

export default function QueuePage() {
  const { shopDomain } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const { revalidate } = useRevalidator();
  const [queueData, setQueueData] = useState<any>(null);
  const { t } = useTranslation();

  const STATUS_LABEL: Record<string, string> = {
    completed: t("common.completed"),
    failed: t("common.failed"),
    cancelled: t("common.cancelled"),
    running: t("common.processing"),
    queued: t("queue.queued"),
    completed_with_errors: t("import.completedWithErrors"),
  };

  // Poll queue status every 3s
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/import-queue?shop=${shopDomain}`);
        const json = await res.json();
        if (active) setQueueData(json);
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { active = false; clearInterval(interval); };
  }, [shopDomain]);

  // Revalidate after cancel
  useEffect(() => {
    if (fetcher.data) {
      revalidate();
    }
  }, [fetcher.data, revalidate]);

  const cancel = (itemId: string) => {
    fetcher.submit(
      { intent: "cancel", itemId },
      { method: "POST", action: `/api/import-queue?shop=${shopDomain}` }
    );
  };

  const cancelScheduled = (configId: string, importMode: string) => {
    const intent = importMode === "bulk" ? "cancel-bulk" : "cancel-scheduled";
    fetcher.submit(
      { intent, configId },
      { method: "POST", action: `/api/import-queue?shop=${shopDomain}` }
    );
  };

  const cancelBulkJob = (bulkJobId: string) => {
    fetcher.submit(
      { intent: "cancel-bulk-job", bulkJobId },
      { method: "POST", action: `/api/import-queue?shop=${shopDomain}` }
    );
  };

  const cancelLog = (logId: string) => {
    fetcher.submit(
      { intent: "cancel-log", logId },
      { method: "POST", action: `/api/import-queue?shop=${shopDomain}` }
    );
  };



  const active = queueData?.active || [];
  const queued = queueData?.queued || [];
  const recent = queueData?.recent || [];
  const schedulerActive = queueData?.schedulerActive || [];

  return (
    <Page
      title={t("queue.title")}
      titleMetadata={<span data-tutorial="queue-page" aria-hidden />}
    >
      <Layout>
        <Layout.Section>
        <BlockStack gap="400">

          <div data-tutorial="queue-active">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">{t("queue.inProgress")}</Text>
                {active.length > 0 ? (
                  active.map((item: any) => {
                    const progress = item.progress;
                    const pct = progress && progress.totalProducts > 0
                      ? Math.round((progress.processedProducts / progress.totalProducts) * 100)
                      : 0;
                    return (
                      <BlockStack key={item.id} gap="200">
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone="attention">{t("common.processing")}</Badge>
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {item.supplierName || item.configId}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {item.sourceLabel || ""}
                          </Text>
                        </InlineStack>
                        {progress ? (
                          <BlockStack gap="100">
                            <ProgressBar progress={pct} size="small" />
                            <InlineStack gap="300" blockAlign="center">
                              <Text as="span" variant="bodySm">
                                {progress.processedProducts} / {progress.totalProducts} {t("queue.products")}
                              </Text>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {t("queue.lastSku")} {progress.lastSku || "—"}
                              </Text>
                              {progress.errors > 0 && (
                                <Badge tone="critical">{`${progress.errors} ${t("common.errors")}`}</Badge>
                              )}
                            </InlineStack>
                          </BlockStack>
                        ) : (
                          <Text as="span" variant="bodySm" tone="subdued">{t("queue.starting")}</Text>
                        )}
                        <Button size="slim" tone="critical" onClick={() => cancel(item.id)}>
                          {t("common.cancel")}
                        </Button>
                      </BlockStack>
                    );
                  })
                ) : (
                  <Text as="p" tone="subdued">{t("queue.noRunning")}</Text>
                )}
              </BlockStack>
            </Card>
          </div>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{t("queue.inProgressCron")}</Text>
              {schedulerActive.length > 0 ? (
                schedulerActive.map((item: any) => {
                  const progress = item.progress;
                  const pct = progress && progress.totalProducts > 0
                    ? Math.round((progress.processedProducts / progress.totalProducts) * 100)
                    : 0;
                  return (
                    <BlockStack key={item.configId} gap="200">
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone="warning">{t("common.scheduled")}</Badge>
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {item.supplierName || item.configId}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {item.sourceLabel || ""}
                        </Text>
                      </InlineStack>
                      {progress ? (
                        <BlockStack gap="100">
                          <ProgressBar progress={pct} size="small" />
                          <InlineStack gap="300" blockAlign="center">
                            <Text as="span" variant="bodySm">
                              {progress.processedProducts} / {progress.totalProducts} {t("queue.products")}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {t("queue.lastSku")} {progress.lastSku || "—"}
                            </Text>
                            {progress.errors > 0 && (
                              <Badge tone="critical">{`${progress.errors} ${t("common.errors")}`}</Badge>
                            )}
                          </InlineStack>
                        </BlockStack>
                      ) : (
                        <Text as="span" variant="bodySm" tone="subdued">{t("queue.starting")}</Text>
                      )}
                      <Button
                        size="slim"
                        tone="critical"
                        onClick={() => {
                          if (item.bulkJobId) {
                            cancelBulkJob(item.bulkJobId);
                          } else if (item.logId && !item.configId) {
                            cancelLog(item.logId);
                          } else {
                            cancelScheduled(item.configId, item.importMode);
                          }
                        }}
                      >
                        {t("common.cancel")}
                      </Button>
                    </BlockStack>
                  );
                })
              ) : (
                <Text as="p" tone="subdued">{t("queue.noCron")}</Text>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{t("queue.queued")}</Text>
              {queued.length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "numeric"]}
                  headings={[t("queue.number"), t("common.supplier"), t("common.source"), t("common.mode"), t("common.actions")]}
                  rows={queued.map((item: any, i: number) => [
                    item.position,
                    item.supplierName || item.configId,
                    <Text key={item.id} as="span" variant="bodySm" truncate>
                      {item.sourceLabel || "—"}
                    </Text>,
                    item.importMode === "bulk" ? t("common.bulk") : t("common.chunks"),
                    <Button key={`cancel-${item.id}`} size="slim" tone="critical" onClick={() => cancel(item.id)}>
                      {t("common.cancel")}
                    </Button>,
                  ])}
                />
              ) : (
                <Text as="p" tone="subdued">{t("queue.noQueued")}</Text>
              )}
            </BlockStack>
          </Card>

          <div data-tutorial="queue-recent">
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="300" blockAlign="center">
                  <Text as="h2" variant="headingMd">{t("queue.recent")}</Text>
                </InlineStack>
                {recent.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "text", "text", "text"]}
                    headings={[t("common.supplier"), t("common.source"), t("common.status"), t("common.trigger"), t("common.total"), t("common.created"), t("common.updated"), t("common.unchanged"), t("common.excluded"), t("queue.priceDown"), t("queue.stockDown"), t("common.errors"), t("common.startDate"), t("common.endDate")]}
                    rows={recent.map((item: any) => [
                      item.supplierName || item.configId,
                      <Text key={item.id} as="span" variant="bodySm" truncate>
                        {item.sourceLabel || "—"}
                      </Text>,
                      <Badge key={`badge-${item.id}`} tone={STATUS_TONE[item.status] || "info"}>
                        {STATUS_LABEL[item.status] || item.status}
                      </Badge>,
                      item.triggerType === "manual" ? t("common.manual") : t("common.scheduled"),
                      item.totalProducts ?? "—",
                      item.created ?? "—",
                      item.updated ?? "—",
                      item.unchanged ?? "—",
                      item.excludedCount ?? "—",
                      item.priceChanges ?? "—",
                      item.stockChanges ?? "—",
                      (item.errorCount ?? 0) > 0 ? (
                        <details key={`er-${item.id}`}>
                          <summary style={{ cursor: "pointer", color: "#d82c0d" }}>
                            {item.errorCount} {t("common.errors")}
                          </summary>
                          <ul style={{ margin: "4px 0", padding: "0 16px", fontSize: "12px" }}>
                            {(item.errorDetails || []).slice(0, 5).map((e: any, i: number) => (
                              <li key={i}>
                                <strong>{e.sku || "?"}</strong>: {e.error}
                              </li>
                            ))}
                            {(item.errorDetails || []).length > 5 && (
                              <li>{t("queue.andMore", { count: item.errorDetails.length - 5 })}</li>
                            )}
                          </ul>
                        </details>
                      ) : "0",
                      item.startedAt ? new Date(item.startedAt).toLocaleString("es-ES") : "—",
                      item.finishedAt ? new Date(item.finishedAt).toLocaleString("es-ES") : "—",
                    ])}
                  />
                ) : (
                  <Text as="p" tone="subdued">{t("queue.noRecent")}</Text>
                )}
              </BlockStack>
            </Card>
            </div>
        </BlockStack>
      </Layout.Section>
    </Layout>
    </Page>
  );
}
