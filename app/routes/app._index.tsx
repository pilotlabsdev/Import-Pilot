import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data, useLoaderData, useFetcher, Link, useNavigate } from "react-router";
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
  Modal,
  FormLayout,
  TextField,
  Banner,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { authenticate } from "~/shopify.server";
import { prisma } from "~/lib/db.server";
import { getSubscriptionInfo, canAddSupplier, enforcePlanLimits } from "~/lib/billing.server";

const FREQUENCY_LABELS: Record<string, string> = {
  "30min": "frequency.every30min",
  hourly: "frequency.hourly",
  "2h": "frequency.every2h",
  "3h": "frequency.every3h",
  "4h": "frequency.every4h",
  "6h": "frequency.every6h",
  "12h": "frequency.every12h",
  daily: "frequency.daily",
  weekly: "frequency.weekly",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  await enforcePlanLimits(shopDomain);

  const configs = await prisma.importConfig.findMany({
    where: { shopDomain },
    include: {
      logs: { orderBy: { startedAt: "desc" }, take: 1 },
      _count: { select: { products: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const suppliers = configs.map((c) => ({
    id: c.id,
    name: c.name,
    csvUrl: c.csvUrl,
    dataSource: c.dataSource,
    isActive: c.isActive,
    planPaused: c.planPaused,
    importMode: c.importMode,
    frequency: c.frequency,
    lastImportAt: c.lastImportAt?.toISOString() || null,
    lastLogStatus: c.logs[0]?.status || null,
    productCount: c._count.products,
  }));

  const [subscription, canAdd] = await Promise.all([
    getSubscriptionInfo(shopDomain),
    canAddSupplier(shopDomain),
  ]);

  return data({ suppliers, subscription, canAdd });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "create") {
    const name = (form.get("name") as string)?.trim();
    if (!name) return data({ error: "Nombre requerido" }, { status: 400 });

    const canAdd = await canAddSupplier(shopDomain);
    if (!canAdd) {
      return data({ error: "Límite de proveedores alcanzado. Sube de plan para agregar más." }, { status: 400 });
    }

    const config = await prisma.importConfig.create({
      data: {
        shopDomain,
        name,
        csvUrl: "",
      },
    });
    await enforcePlanLimits(shopDomain);
    return data({ success: true, configId: config.id });
  }

  if (intent === "delete") {
    const configId = form.get("configId") as string;
    if (!configId) return data({ error: "Config ID requerido" }, { status: 400 });

    await prisma.importConfig.delete({ where: { id: configId } });
    await enforcePlanLimits(shopDomain);
    return data({ success: true });
  }

  return data({ error: "Intento no válido" }, { status: 400 });
};

export default function SupplierList() {
  const { suppliers, subscription, canAdd } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const { t } = useTranslation();

  const handleCreate = useCallback(() => {
    if (!newName.trim()) return;
    fetcher.submit(
      { intent: "create", name: newName.trim() },
      { method: "POST" }
    );
    setShowCreate(false);
    setNewName("");
  }, [newName, fetcher]);

  const handleDelete = useCallback(() => {
    if (!deleteId) return;
    fetcher.submit(
      { intent: "delete", configId: deleteId },
      { method: "POST" }
    );
    setDeleteId(null);
  }, [deleteId, fetcher]);

  return (
    <Page
      title={t("dashboard.title")}
      titleMetadata={<span data-tutorial="page-title" aria-hidden />}
      primaryAction={{
        content: t("dashboard.newSupplier"),
        onAction: () => setShowCreate(true),
        disabled: !canAdd,
      }}
    >
      <Layout>
        <Layout.Section>
          {!canAdd && (
            <Banner
              title={t("dashboard.supplierLimit")}
              tone="info"
              action={subscription.supplierLimit < 5 ? { content: t("dashboard.viewPlans"), onAction: () => navigate("/app/billing") } : undefined}
            >
              <p>
                {t("dashboard.supplierLimitMessage", { count: subscription.supplierLimit, supplierLimit: subscription.supplierLimit })}
                {subscription.supplierLimit < 5
                  ? t("dashboard.supplierLimitUpgrade")
                  : t("dashboard.supplierLimitDelete")}
              </p>
            </Banner>
          )}
          {suppliers.some((s: any) => s.planPaused) && (
            <Banner
              title={t("dashboard.disabledByPlan")}
              tone="warning"
              action={{ content: t("dashboard.viewPlans"), onAction: () => navigate("/app/billing") }}
            >
              <p>
                {t("dashboard.disabledByPlanMessage", { count: suppliers.filter((s: any) => s.planPaused).length })}
                {t("dashboard.disabledByPlanUpgrade")}
              </p>
            </Banner>
          )}
          <div data-tutorial="supplier-list">
          <Card>
            {suppliers.length === 0 ? (
              <EmptyState
                heading={t("dashboard.noSuppliers")}
                action={{
                  content: t("dashboard.createSupplier"),
                  onAction: () => setShowCreate(true),
                }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  {t("dashboard.createFirst")}
                </p>
              </EmptyState>
            ) : (
              <BlockStack gap="0">
                {suppliers.map((s: any, i: number) => (
                  <div key={s.id}>
                    <div
                      style={{
                        padding: "16px 20px",
                        borderBottom:
                          i < suppliers.length - 1
                            ? "1px solid var(--p-color-border-secondary)"
                            : undefined,
                        background: s.planPaused ? "rgba(0,0,0,0.03)" : undefined,
                        opacity: s.planPaused ? 0.55 : 1,
                      }}
                    >
                      <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <BlockStack gap="050">
                            <InlineStack align="space-between" blockAlign="center">
                              <Text variant="headingSm" as="h3">
                                {s.name}
                              </Text>
                              {s.planPaused ? (
                                <Badge tone="critical">{t("dashboard.disabledBadge")}</Badge>
                              ) : (
                                <Badge tone={s.isActive ? "success" : "info"}>
                                  {s.isActive ? t("common.active") : t("common.inactive")}
                                </Badge>
                              )}
                            </InlineStack>
                            {s.planPaused && (
                              <Text variant="bodySm" tone="subdued" as="p">
                                {t("import.planDisabledMessage")}
                              </Text>
                            )}
                            <Text variant="bodySm" tone="subdued" as="p">
                              {s.productCount} {t("dashboard.products")} · {t("common.mode")}:{" "}
                              {s.importMode === "bulk" ? t("common.bulk") : t("common.chunks")}
                              {s.frequency ? ` · ${t("dashboard.frequency")}: ${t(FREQUENCY_LABELS[s.frequency] || "frequency." + s.frequency)}` : ""}
                              {s.lastImportAt
                                ? ` · ${t("dashboard.lastImport")} ${new Date(s.lastImportAt).toLocaleDateString("es-ES")}`
                                : ""}
                            </Text>
                            {s.dataSource === "file" ? (
                              <Badge tone="info">{t("dashboard.uploadedFile")}</Badge>
                            ) : s.csvUrl ? (
                              <Text variant="bodySm" tone="subdued" as="p" breakWord>
                                {s.csvUrl}
                              </Text>
                            ) : null}
                          </BlockStack>
                        </div>
                        {!s.planPaused ? (
                        <div style={{ display: "flex", gap: "4px", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <Link to={`/app/supplier/${s.id}`}>
                            <span data-tutorial="configure-btn">
                            <Button size="slim">
                              {t("dashboard.configure")}
                            </Button>
                            </span>
                          </Link>
                          <Link to={`/app/supplier/${s.id}/logs`}>
                            <span data-tutorial="history-btn">
                            <Button size="slim">
                              {t("dashboard.history")}
                            </Button>
                            </span>
                          </Link>
                          <span data-tutorial="delete-btn">
                          <Button
                            size="slim"
                            tone="critical"
                            onClick={() => setDeleteId(s.id)}
                          >
                            {t("common.delete")}
                          </Button>
                          </span>
                        </div>
                        ) : (
                        <div style={{ display: "flex", gap: "4px", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <span data-tutorial="delete-btn">
                          <Button
                            size="slim"
                            tone="critical"
                            onClick={() => setDeleteId(s.id)}
                          >
                            {t("common.delete")}
                          </Button>
                          </span>
                        </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </BlockStack>
            )}
          </Card>
          </div>
        </Layout.Section>
      </Layout>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title={t("dashboard.newSupplier")}
        primaryAction={{
          content: t("common.create"),
          onAction: handleCreate,
        }}
        secondaryActions={[
          {
            content: t("common.cancel"),
            onAction: () => setShowCreate(false),
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField
              label={t("dashboard.supplierName")}
              value={newName}
              onChange={setNewName}
              placeholder={t("dashboard.supplierNamePlaceholder")}
              autoFocus
              autoComplete="off"
            />
          </FormLayout>
        </Modal.Section>
      </Modal>

      <Modal
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        title={t("dashboard.deleteSupplier")}
        primaryAction={{
          content: t("common.delete"),
          destructive: true,
          onAction: handleDelete,
        }}
        secondaryActions={[
          {
            content: t("common.cancel"),
            onAction: () => setDeleteId(null),
          },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            {t("dashboard.deleteWarning")}
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
