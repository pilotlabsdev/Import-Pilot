import type { LoaderFunctionArgs } from "react-router";
import { data, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Select,
  Button,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { useTranslation } from "react-i18next";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return data({});
};

export default function TutorialSettings() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const MOCK_PRIORITY = [
    { name: t("tutorialMock.supplierAlpha"), id: "alpha" },
    { name: t("tutorialMock.supplierBeta"), id: "beta" },
  ];

  return (
    <Page
      title={t('settings.title')}
      backAction={{ content: t('nav.dashboard'), onAction: () => navigate("/app") }}
    >
      <Layout>
        <Layout.Section>
          <div data-tutorial="settings-page">
            <div data-tutorial="settings-duplicate-policy">
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">
                    {t('settings.duplicatePolicy')}
                  </Text>
                  <Text variant="bodySm" as="p" tone="subdued">
                    {t('settings.duplicatePolicyHelp')}
                  </Text>
                  <Select
                    label={t('settings.whenDuplicate')}
                    options={[
                      { label: t('settings.createBoth'), value: "create_both" },
                      { label: t('settings.prioritySupplier'), value: "priority" },
                      { label: t('settings.noCreateIfExist'), value: "skip_existing" },
                    ]}
                    value="priority"
                    disabled
                  />
                </BlockStack>
              </Card>
            </div>

            <div data-tutorial="settings-priority">
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">
                    {t('settings.supplierPriority')}
                  </Text>
                  <Text variant="bodySm" as="p" tone="subdued">
                    {t('settings.supplierPriorityHelp')}
                  </Text>

                  <BlockStack gap="200">
                    {MOCK_PRIORITY.map((supplier, index) => (
                      <InlineStack
                        key={supplier.id}
                        align="space-between"
                        blockAlign="center"
                      >
                        <InlineStack gap="200" blockAlign="center">
                          <Text variant="bodyMd" as="p" fontWeight="semibold">
                            {index + 1}.
                          </Text>
                          <Text variant="bodyMd" as="p">{supplier.name}</Text>
                        </InlineStack>
                        <InlineStack gap="100">
                          <Button size="slim" disabled={index === 0}>↑</Button>
                          <Button size="slim" disabled={index === MOCK_PRIORITY.length - 1}>↓</Button>
                          <Button size="slim" tone="critical" disabled>{t('settings.remove')}</Button>
                        </InlineStack>
                      </InlineStack>
                    ))}
                  </BlockStack>

                  <BlockStack gap="200">
                    <Text variant="bodySm" as="p" tone="subdued">
                      {t('settings.unassignedSuppliers')}
                    </Text>
                    <InlineStack gap="200" wrap>
                      <Button size="slim" disabled>{t("tutorialMock.addSupplier")}</Button>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              </Card>
            </div>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
