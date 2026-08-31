import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data, useLoaderData, useFetcher, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Select,
  Button,
  Banner,
  Badge,
} from "@shopify/polaris";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { authenticate } from "~/shopify.server";
import { prisma } from "~/lib/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  let settings = await prisma.shopSettings.findUnique({
    where: { shopDomain },
  });

  if (!settings) {
    settings = await prisma.shopSettings.create({
      data: { shopDomain },
    });
  }

  const suppliers = await prisma.importConfig.findMany({
    where: { shopDomain },
    select: { id: true, name: true, planPaused: true },
    orderBy: { createdAt: "asc" },
  });

  return data({ settings, suppliers });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "updatePolicy") {
    const duplicatePolicy = form.get("duplicatePolicy") as string;
    await prisma.shopSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, duplicatePolicy },
      update: { duplicatePolicy },
    });
    return data({ success: true });
  }

  if (intent === "updatePriority") {
    const priorityJson = form.get("supplierPriority") as string;
    await prisma.shopSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, supplierPriority: priorityJson },
      update: { supplierPriority: priorityJson },
    });
    return data({ success: true });
  }

  return data({ error: "Intento no válido" }, { status: 400 });
};

export default function Settings() {
  const { settings, suppliers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [policy, setPolicy] = useState(settings.duplicatePolicy);
  const [priority, setPriority] = useState<string[]>(() => {
    try {
      return settings.supplierPriority ? JSON.parse(settings.supplierPriority) : [];
    } catch {
      return [];
    }
  });

  const DUPLICATE_OPTIONS = [
    {
      label: t("settings.createBoth"),
      value: "create_both",
      description: t("settings.createBothHelp"),
    },
    {
      label: t("settings.prioritySupplier"),
      value: "priority",
      description: t("settings.prioritySupplierHelp"),
    },
    {
      label: t("settings.noCreateIfExist"),
      value: "skip_existing",
      description: t("settings.noCreateIfExistHelp"),
    },
  ];

  function submitPriority(newPriority: string[]) {
    fetcher.submit(
      { intent: "updatePriority", supplierPriority: JSON.stringify(newPriority) },
      { method: "POST" }
    );
  }

  function handlePolicyChange(value: string) {
    setPolicy(value);
    fetcher.submit(
      { intent: "updatePolicy", duplicatePolicy: value },
      { method: "POST" }
    );
  }

  function moveUp(index: number) {
    const next = [...priority];
    if (index === 0) return;
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    setPriority(next);
    submitPriority(next);
  }

  function moveDown(index: number) {
    const next = [...priority];
    if (index >= next.length - 1) return;
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    setPriority(next);
    submitPriority(next);
  }

  function addToPriority(supplierId: string) {
    if (priority.includes(supplierId)) return;
    const next = [...priority, supplierId];
    setPriority(next);
    submitPriority(next);
  }

  function removeFromPriority(supplierId: string) {
    const next = priority.filter((id) => id !== supplierId);
    setPriority(next);
    submitPriority(next);
  }

  const getSupplierName = (id: string) =>
    suppliers.find((s) => s.id === id)?.name || id;

  const unassignedSuppliers = suppliers.filter((s) => !priority.includes(s.id) && !s.planPaused);

  return (
    <Page
      title={t("settings.title")}
      titleMetadata={<span data-tutorial="settings-page" aria-hidden />}
      backAction={{ content: t("nav.dashboard"), onAction: () => navigate("/app") }}
    >
      <Layout>
        <Layout.Section>
          <div data-tutorial="settings-duplicate-policy">
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                {t("settings.duplicatePolicy")}
              </Text>
              <Text variant="bodySm" as="p" tone="subdued">
                {t("settings.duplicatePolicyHelp")}
              </Text>
              <Select
                label={t("settings.whenDuplicate")}
                options={DUPLICATE_OPTIONS}
                value={policy}
                onChange={handlePolicyChange}
              />
              {policy === "skip_existing" && (
                <Banner tone="warning">
                  <p>
                    {t("settings.noCreateIfExistDetail")}
                  </p>
                </Banner>
              )}
            </BlockStack>
          </Card>
          </div>
        </Layout.Section>

        {policy === "priority" && (
          <Layout.Section>
            <div data-tutorial="settings-priority">
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">
                  {t("settings.supplierPriority")}
                </Text>
                <Text variant="bodySm" as="p" tone="subdued">
                  {t("settings.supplierPriorityHelp")}
                </Text>

                {priority.length > 0 ? (
                  <BlockStack gap="200">
                    {priority.map((id, index) => (
                      <InlineStack
                        key={id}
                        align="space-between"
                        blockAlign="center"
                      >
                        <InlineStack gap="200" blockAlign="center">
                          <Text variant="bodyMd" as="p" fontWeight="semibold">
                            {index + 1}.
                          </Text>
                          <Text variant="bodyMd" as="p">{getSupplierName(id)}</Text>
                          {suppliers.find((s) => s.id === id)?.planPaused && (
                            <Badge tone="critical">Pausado</Badge>
                          )}
                        </InlineStack>
                        <InlineStack gap="100">
                          <Button
                            size="slim"
                            onClick={() => moveUp(index)}
                            disabled={index === 0}
                          >
                            ↑
                          </Button>
                          <Button
                            size="slim"
                            onClick={() => moveDown(index)}
                            disabled={index === priority.length - 1}
                          >
                            ↓
                          </Button>
                          <Button
                            size="slim"
                            tone="critical"
                            onClick={() => removeFromPriority(id)}
                          >
                            {t("settings.remove")}
                          </Button>
                        </InlineStack>
                      </InlineStack>
                    ))}
                  </BlockStack>
                ) : (
                  <Banner tone="info">
                    <p>
                      {t("settings.addSuppliers")}
                    </p>
                  </Banner>
                )}

                {unassignedSuppliers.length > 0 && (
                  <BlockStack gap="200">
                    <Text variant="bodySm" as="p" tone="subdued">
                      {t("settings.unassignedSuppliers")}
                    </Text>
                    <InlineStack gap="200" wrap>
                      {unassignedSuppliers.map((s) => (
                        <Button
                          key={s.id}
                          size="slim"
                          onClick={() => addToPriority(s.id)}
                        >
                          + {s.name}
                        </Button>
                      ))}
                    </InlineStack>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
            </div>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
