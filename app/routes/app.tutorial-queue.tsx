import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import {
  Badge,
  Banner,
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return data({});
};

export default function TutorialQueuePage() {
  const { t } = useTranslation();
  return (
    <Page title={t('queue.title')} titleMetadata={<span data-tutorial="queue-page" aria-hidden />}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">

            <div data-tutorial="queue-active">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">{t('queue.inProgress')} {t("tutorialMock.queueLabel")}</Text>

                  <BlockStack gap="200">
                    <InlineStack gap="200" blockAlign="center">
                      <Badge tone="attention">{t('common.processing')}</Badge>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {t("tutorialMock.supplierAlpha")}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {t('dashboard.uploadedFile')}
                      </Text>
                    </InlineStack>
                    <BlockStack gap="100">
                      <ProgressBar progress={65} size="small" />
                      <InlineStack gap="300" blockAlign="center">
                        <Text as="span" variant="bodySm">
                          {t("tutorialMock.progress1")} {t('queue.products')}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {t('queue.lastSku')} SKU-8934
                        </Text>
                      </InlineStack>
                    </BlockStack>
                    <Button size="slim" tone="critical" disabled>
                      {t('common.cancel')}
                    </Button>
                  </BlockStack>
                </BlockStack>
              </Card>
            </div>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">{t('queue.inProgressCron')}</Text>

                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone="warning">{t('common.scheduled')}</Badge>
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {t("tutorialMock.supplierBeta")}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {t("tutorialMock.exampleUrl")}
                    </Text>
                  </InlineStack>
                  <BlockStack gap="100">
                    <ProgressBar progress={30} size="small" />
                    <InlineStack gap="300" blockAlign="center">
                      <Text as="span" variant="bodySm">
                        {t("tutorialMock.progress2")} {t('queue.products')}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {t('queue.lastSku')} SKU-1102
                      </Text>
                    </InlineStack>
                  </BlockStack>
                  <Button size="slim" tone="critical" disabled>
                    {t('common.cancel')}
                  </Button>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">{t('queue.queued')} {t("tutorialMock.queueCount")}</Text>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "numeric"]}
                  headings={[t('queue.number'), t('common.supplier'), t('common.source'), t('common.mode'), t('common.actions')]}
                  rows={[
                    [2, t("tutorialMock.supplierGamma"), t("tutorialMock.feedUrl"), t('common.chunks'), t('common.cancel')],
                  ]}
                />
              </BlockStack>
            </Card>

            <div data-tutorial="queue-recent">
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="300" blockAlign="center">
                  <Text as="h2" variant="headingMd">{t('queue.recent')}</Text>
                  <Button size="slim" tone="critical" disabled>
                    {t('queue.cleanCompleted')}
                  </Button>
                </InlineStack>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text"]}
                  headings={[t('common.supplier'), t('common.source'), t('common.status'), t('common.startDate'), t('common.endDate')]}
                  rows={[
                    [
                      t("tutorialMock.supplierBeta"),
                      t("tutorialMock.exampleUrl"),
                      <Badge key="1" tone="success">{t('common.completed')}</Badge>,
                      t("tutorialMock.date3"),
                      t("tutorialMock.date4"),
                    ],
                    [
                      t("tutorialMock.supplierAlpha"),
                      t('dashboard.uploadedFile'),
                      <Badge key="2" tone="success">{t('common.completed')}</Badge>,
                      t("tutorialMock.date1"),
                      t("tutorialMock.date2"),
                    ],
                    [
                      t("tutorialMock.supplierBeta"),
                      t("tutorialMock.exampleUrl"),
                      <Badge key="3" tone="critical">{t('common.failed')}</Badge>,
                      t("tutorialMock.date5"),
                      t("tutorialMock.date6"),
                    ],
                    [
                      t("tutorialMock.supplierGamma"),
                      t("tutorialMock.feedUrl"),
                      <Badge key="4" tone="success">{t('common.completed')}</Badge>,
                      t("tutorialMock.date7"),
                      t("tutorialMock.date8"),
                    ],
                  ]}
                />
              </BlockStack>
            </Card>
            </div>

          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
