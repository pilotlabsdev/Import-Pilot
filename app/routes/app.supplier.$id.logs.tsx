import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";

import { useLoaderData } from "react-router";
import {
  Badge,
  BlockStack,
  Card,
  DataTable,
  Text,
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";

import { prisma } from "~/lib/db.server";
import { authenticate } from "~/shopify.server";
import { parseSystemError } from "~/lib/system-errors";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configId = params.id as string;

  const logs = await prisma.importLog.findMany({
    where: { configId },
    orderBy: { startedAt: "desc" },
    take: 50,
  });

  return data({ logs, shopDomain, configId });
};

function statusTone(status: string) {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "critical";
    default:
      return "attention";
  }
}

export default function Logs() {
  const { logs, shopDomain, configId } = useLoaderData<typeof loader>();
  const { t } = useTranslation();

  const rows = logs.map((log) => {
    const errors = log.errors ? JSON.parse(log.errors) : [];

    return [
      new Date(log.startedAt).toLocaleString("es-ES"),
      log.completedAt ? new Date(log.completedAt).toLocaleString("es-ES") : "—",
      <Badge key={`st-${log.id}`} tone={statusTone(log.status)}>
        {log.status}
      </Badge>,
      log.triggerType,
      String(log.totalProducts),
      String(log.created),
      String(log.updated),
      String(log.unchanged),
      String(log.excludedCount),
      String(log.priceChanges),
      String(log.stockChanges),
      String(log.costChanges),
      errors.length > 0 ? (
        <details key={`er-${log.id}`}>
          <summary style={{ cursor: "pointer", color: "#d82c0d" }}>
            {errors.length} {t("history.errors")}
          </summary>
          <ul style={{ margin: "4px 0", padding: "0 16px", fontSize: "12px" }}>
            {errors.map((e: any, i: number) => {
              const parsed = parseSystemError(e.error || "");
              return (
                <li key={i}>
                  <strong>{e.sku || "?"}</strong>: {t(parsed.key, parsed.vars || {})}{e.lineNumber ? ` (${t("history.line")} ${e.lineNumber})` : ""}
                </li>
              );
            })}
          </ul>
        </details>
      ) : (
        "0"
      ),
    ];
  });

  return (
    <>
      {logs.length === 0 ? (
        <Card>
          <Text as="p" variant="bodyMd" tone="subdued">
            {t("history.noLogs")}
          </Text>
        </Card>
      ) : (
        <BlockStack gap="300">
          <Card padding="0">
            <DataTable
              columnContentTypes={[
                "text", "text", "text", "text", "numeric", "numeric",
                "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "text",
              ]}
              headings={[
                t("common.startDate"), t("common.endDate"), t("common.status"), t("common.trigger"), t("common.total"), t("common.created"),
                t("common.updated"), t("common.unchanged"), t("common.excluded"), t("history.priceDown"), t("history.stockDown"), t("history.costDown"), t("common.errors"),
              ]}
              rows={rows}
            />
          </Card>
        </BlockStack>
      )}
    </>
  );
}
