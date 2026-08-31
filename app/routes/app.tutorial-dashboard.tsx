import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  Text,
  EmptyState,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { useTranslation } from "react-i18next";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return data({});
};

export default function TutorialDashboard() {
  useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const suppliers = [
    {
      id: "mock-1",
      name: t("tutorialMock.supplierAlpha"),
      productCount: 1247,
      importMode: "bulk",
      isActive: true,
      lastImportAt: "27/08/2026",
      csvUrl: t("tutorialMock.alphaUrl"),
    },
    {
      id: "mock-2",
      name: t("tutorialMock.supplierBeta"),
      productCount: 356,
      importMode: "chunks",
      isActive: false,
      lastImportAt: "25/08/2026",
      csvUrl: t("tutorialMock.betaUrl"),
    },
  ];

  return (
    <Page
      title={t('dashboard.title')}
      primaryAction={{
        content: t('dashboard.newSupplier'),
        onAction: () => {},
      }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="0">
              {suppliers.map((s: any, i: number) => (
                <div key={s.id}>
                  <div
                    data-tutorial="supplier-list"
                    style={{
                      padding: "16px 20px",
                      borderBottom:
                        i < suppliers.length - 1
                          ? "1px solid var(--p-color-border-secondary)"
                          : undefined,
                    }}
                  >
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="050">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text variant="headingSm" as="h3">
                            {s.name}
                          </Text>
                          <Badge tone={s.isActive ? "success" : "info"}>
                            {s.isActive ? t('common.active') : t('common.inactive')}
                          </Badge>
                        </InlineStack>
                        <Text variant="bodySm" tone="subdued" as="p">
                          {s.productCount} {t('dashboard.products')} · {t('common.mode')}:{" "}
                          {s.importMode === "bulk" ? t('common.bulk') : t('common.chunks')}
                          {s.lastImportAt
                            ? ` · ${t('dashboard.lastImport')} ${s.lastImportAt}`
                            : ""}
                        </Text>
                        <Text variant="bodySm" tone="subdued" as="p" truncate>
                          {s.csvUrl}
                        </Text>
                      </BlockStack>
                      <InlineStack gap="100">
                        <div data-tutorial="configure-btn">
                          <Button
                            size="slim"
                            onClick={() =>
                              navigate(`/app/tutorial/supplier/import`)
                            }
                          >
                            {t('dashboard.configure')}
                          </Button>
                        </div>
                        <div data-tutorial="history-btn">
                          <Button
                            size="slim"
                            onClick={() =>
                              navigate(`/app/tutorial/supplier/logs`)
                            }
                          >
                            {t('dashboard.history')}
                          </Button>
                        </div>
                        <div data-tutorial="delete-btn">
                          <Button size="slim" tone="critical">
                            {t('common.delete')}
                          </Button>
                        </div>
                      </InlineStack>
                    </InlineStack>
                  </div>
                </div>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
