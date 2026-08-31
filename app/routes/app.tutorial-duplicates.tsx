import type { LoaderFunctionArgs } from "react-router";
import { data, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  DataTable,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { useTranslation } from "react-i18next";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return data({});
};

export default function TutorialDuplicates() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const MOCK_DUPLICATES = [
    {
      ean: "1234567890123",
      supplierA: t("tutorialMock.supplierAlpha"),
      skuA: "ALPHA-001",
      supplierB: t("tutorialMock.supplierBeta"),
      skuB: "BETA-001",
      detectedAt: "27/08/2026",
      resolved: false,
    },
    {
      ean: "9876543210987",
      supplierA: t("tutorialMock.supplierAlpha"),
      skuA: "ALPHA-045",
      supplierB: t("tutorialMock.supplierBeta"),
      skuB: "BETA-102",
      detectedAt: "26/08/2026",
      resolved: true,
    },
  ];

  const unresolvedCount = MOCK_DUPLICATES.filter((d) => !d.resolved).length;

  const rows = MOCK_DUPLICATES.map((d) => [
    <Text key="ean" variant="bodyMd" as="p" fontWeight="semibold">
      {d.ean}
    </Text>,
    <BlockStack key="a" gap="0">
      <Text variant="bodyMd" as="p">{d.supplierA}</Text>
      <Text variant="bodySm" as="p" tone="subdued">
        {t("tutorialMock.skuLabel")}: {d.skuA}
      </Text>
    </BlockStack>,
    <BlockStack key="b" gap="0">
      <Text variant="bodyMd" as="p">{d.supplierB}</Text>
      <Text variant="bodySm" as="p" tone="subdued">
        {t("tutorialMock.skuLabel")}: {d.skuB}
      </Text>
    </BlockStack>,
    <Text key="date" variant="bodySm" as="p" tone="subdued">
      {d.detectedAt}
    </Text>,
    d.resolved ? (
      <Button key="unresolve" size="slim" variant="tertiary" disabled>
        {t('duplicates.undo')}
      </Button>
    ) : (
      <Button key="resolve" size="slim" disabled>
        {t('duplicates.markResolved')}
      </Button>
    ),
  ]);

  return (
    <Page
      title={t('duplicates.title')}
      backAction={{ content: t('nav.dashboard'), onAction: () => navigate("/app") }}
      primaryAction={
        unresolvedCount > 0
          ? {
              content: t('duplicates.markAllResolved', { count: unresolvedCount }),
              disabled: true,
            }
          : undefined
      }
    >
      <Layout>
        <Layout.Section>
          <div data-tutorial="duplicates-page">
            <div data-tutorial="duplicates-table">
              <Card>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text"]}
                  headings={[t('common.ean'), t('duplicates.supplierA'), t('duplicates.supplierB'), t('duplicates.detected'), t('common.status')]}
                  rows={rows}
                />
              </Card>
            </div>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
