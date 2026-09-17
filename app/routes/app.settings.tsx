import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data, useLoaderData, useActionData, useNavigate, Form } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Select,
  Checkbox,
  Button,
  Banner,
  Badge,
} from "@shopify/polaris";
import { useState, useEffect, useRef, useCallback } from "react";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { useTranslation } from "react-i18next";

import { safeAuthenticate } from "~/shopify.server";
import { prisma } from "~/lib/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await safeAuthenticate(request);
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
  const { session } = await safeAuthenticate(request);
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

  if (intent === "updateMatchMode") {
    const matchMode = form.get("matchMode") as string;
    await prisma.shopSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, matchMode },
      update: { matchMode },
    });
    return data({ success: true });
  }

  if (intent === "updateApplyToExternal") {
    const applyToExternal = form.get("applyToExternal") === "true";
    await prisma.shopSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, applyToExternal },
      update: { applyToExternal },
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

  if (intent === "updateAll") {
    const duplicatePolicy = form.get("duplicatePolicy") as string;
    const matchMode = form.get("matchMode") as string;
    const applyToExternal = form.get("applyToExternal") === "true";
    const supplierPriority = form.get("supplierPriority") as string;
    await prisma.shopSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, duplicatePolicy, matchMode, applyToExternal, supplierPriority },
      update: { duplicatePolicy, matchMode, applyToExternal, supplierPriority },
    });
    return data({ success: true });
  }

  return data({ error: "Intento no válido" }, { status: 400 });
};

export default function Settings() {
  const { settings, suppliers } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { success?: boolean } | undefined;
  const navigate = useNavigate();
  const { t } = useTranslation();
  const shopify = useAppBridge();
  const formRef = useRef<HTMLFormElement>(null);
  const SAVE_BAR_ID = "settings-save-bar";

  const [policy, setPolicy] = useState(settings.duplicatePolicy);
  const [matchMode, setMatchMode] = useState(settings.matchMode || "overwrite");
  const [applyToExternal, setApplyToExternal] = useState(settings.applyToExternal ?? false);
  const [priority, setPriority] = useState<string[]>(() => {
    try {
      return settings.supplierPriority ? JSON.parse(settings.supplierPriority) : [];
    } catch {
      return [];
    }
  });

  const initialRef = useRef({
    policy: settings.duplicatePolicy,
    matchMode: settings.matchMode || "overwrite",
    applyToExternal: settings.applyToExternal ?? false,
    priority: (() => {
      try { return settings.supplierPriority ? JSON.parse(settings.supplierPriority) : []; } catch { return []; }
    })(),
  });

  const [isDirty, setIsDirty] = useState(false);

  const checkDirty = useCallback(() => {
    const init = initialRef.current;
    const dirty =
      policy !== init.policy ||
      matchMode !== init.matchMode ||
      applyToExternal !== init.applyToExternal ||
      JSON.stringify(priority) !== JSON.stringify(init.priority);
    setIsDirty(dirty);
  }, [policy, matchMode, applyToExternal, priority]);

  useEffect(() => { checkDirty(); }, [checkDirty]);

  useEffect(() => {
    if (isDirty) shopify.saveBar.show(SAVE_BAR_ID);
    else shopify.saveBar.hide(SAVE_BAR_ID);
  }, [isDirty, shopify]);

  useEffect(() => {
    if (actionData?.success) {
      initialRef.current = { policy, matchMode, applyToExternal, priority: [...priority] };
      setIsDirty(false);
    }
  }, [actionData?.success, policy, matchMode, applyToExternal, priority]);

  const handleSave = useCallback(() => {
    formRef.current?.requestSubmit();
  }, []);

  const handleDiscard = useCallback(() => {
    const init = initialRef.current;
    setPolicy(init.policy);
    setMatchMode(init.matchMode);
    setApplyToExternal(init.applyToExternal);
    setPriority([...init.priority]);
  }, []);

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

  function moveUp(index: number) {
    const next = [...priority];
    if (index === 0) return;
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    setPriority(next);
  }

  function moveDown(index: number) {
    const next = [...priority];
    if (index >= next.length - 1) return;
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    setPriority(next);
  }

  function addToPriority(supplierId: string) {
    if (priority.includes(supplierId)) return;
    setPriority([...priority, supplierId]);
  }

  function removeFromPriority(supplierId: string) {
    setPriority(priority.filter((id) => id !== supplierId));
  }

  const getSupplierName = (id: string) =>
    suppliers.find((s) => s.id === id)?.name || id;

  const unassignedSuppliers = suppliers.filter((s) => !priority.includes(s.id) && !s.planPaused);

  return (
    <Form ref={formRef} method="post">
      <input type="hidden" name="intent" value="updateAll" />
      <input type="hidden" name="duplicatePolicy" value={policy} />
      <input type="hidden" name="matchMode" value={matchMode} />
      <input type="hidden" name="applyToExternal" value={String(applyToExternal)} />
      <input type="hidden" name="supplierPriority" value={JSON.stringify(priority)} />

      <SaveBar id={SAVE_BAR_ID}>
        <button variant="primary" type="button" onClick={handleSave}>{t("common.save")}</button>
        <button type="button" onClick={handleDiscard}>{t("common.discard")}</button>
      </SaveBar>

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
                  onChange={setPolicy}
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
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">
                    {t("settings.matchMode")}
                  </Text>
                  <Text variant="bodySm" as="p" tone="subdued">
                    {t("settings.matchModeHelp")}
                  </Text>
                  <Select
                    label={t("settings.whenDifferentSku")}
                    options={[
                      { label: t("settings.overwriteFull"), value: "overwrite" },
                      { label: t("settings.updateFiltersOnly"), value: "update" },
                    ]}
                    value={matchMode}
                    onChange={setMatchMode}
                  />
                  {matchMode === "update" && (
                    <Banner tone="info">
                      <p>{t("settings.matchModeUpdateDetail")}</p>
                    </Banner>
                  )}
                  {matchMode === "overwrite" && (
                    <Banner tone="warning">
                      <p>{t("settings.matchModeOverwriteDetail")}</p>
                    </Banner>
                  )}
                  <Checkbox
                    label={t("settings.applyToExternal")}
                    helpText={t("settings.applyToExternalHelp")}
                    checked={applyToExternal}
                    onChange={setApplyToExternal}
                  />
                  {!applyToExternal && (
                    <Banner tone="info">
                      <p>{t("settings.applyToExternalInfo")}</p>
                    </Banner>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

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
    </Form>
  );
}
