import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data, redirect, useLoaderData, Outlet, useLocation, useFetcher, useRevalidator, useNavigate } from "react-router";
import {
  Page,
  Tabs,
  TextField,
  Button,
  Modal,
  FormLayout,
} from "@shopify/polaris";
import { useState, useCallback, useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useTranslation } from "react-i18next";

import { authenticate } from "~/shopify.server";
import { prisma } from "~/lib/db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configId = params.id;

  if (!configId) throw new Response("Missing supplier ID", { status: 400 });

  const config = await prisma.importConfig.findUnique({
    where: { id: configId },
    select: { id: true, name: true, shopDomain: true, planPaused: true },
  });

  if (!config || config.shopDomain !== shopDomain) {
    throw new Response("Proveedor no encontrado", { status: 404 });
  }

  if (config.planPaused) {
    return redirect("/app");
  }

  return data({ config });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "rename") {
    const configId = params.id;
    const name = (form.get("name") as string)?.trim();
    if (!name) return data({ error: "Nombre requerido" }, { status: 400 });

    const config = await prisma.importConfig.findUnique({
      where: { id: configId },
      select: { shopDomain: true },
    });
    if (!config || config.shopDomain !== shopDomain) {
      throw new Response("No autorizado", { status: 403 });
    }

    await prisma.importConfig.update({
      where: { id: configId },
      data: { name },
    });
    return data({ success: true });
  }

  return data({ error: "Intento no válido" }, { status: 400 });
};

const SUPPLIER_TAB_KEYS = [
  { id: "import", key: "supplier.import", url: "/import" },
  { id: "config", key: "supplier.config", url: "/config" },
  { id: "columns", key: "supplier.columns", url: "/columns" },
  { id: "price-rules", key: "supplier.priceRules", url: "/price-rules" },
  { id: "category-mapping", key: "supplier.categories", url: "/category-mapping" },
  { id: "preview", key: "supplier.preview", url: "/preview" },
  { id: "logs", key: "supplier.history", url: "/logs" },
];

export default function SupplierLayout() {
  const { config } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const { revalidate } = useRevalidator();
  const shopify = useAppBridge();
  const { t } = useTranslation();
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(config.name);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      revalidate();
    }
  }, [fetcher.state, fetcher.data, revalidate]);

  useEffect(() => {
    setNameValue(config.name);
  }, [config.name]);

  const basePath = `/app/supplier/${config.id}`;

  const currentTab = SUPPLIER_TAB_KEYS.findIndex((tab) =>
    location.pathname.startsWith(basePath + tab.url)
  );
  const selectedTabIndex = currentTab >= 0 ? currentTab : 0;

  const tabs = SUPPLIER_TAB_KEYS.map((tab) => ({
    id: tab.id,
    content: t(tab.key),
  }));

  const handleTabChange = useCallback(
    (index: number) => {
      shopify.saveBar.leaveConfirmation();
      navigate(basePath + SUPPLIER_TAB_KEYS[index].url);
    },
    [shopify, navigate, basePath]
  );

  const handleRename = useCallback(() => {
    if (!nameValue.trim() || nameValue.trim() === config.name) {
      setEditingName(false);
      setNameValue(config.name);
      return;
    }
    fetcher.submit(
      { intent: "rename", name: nameValue.trim() },
      { method: "POST" }
    );
    setEditingName(false);
  }, [nameValue, config.name, fetcher]);

  const titleMetadata = (
    <span data-tutorial="rename-btn">
    <Button
      variant="plain"
      size="micro"
      onClick={() => {
        setNameValue(config.name);
        setEditingName(true);
      }}
    >
      {t("supplier.editName")}
    </Button>
    </span>
  );

  return (
    <>
      <Page
        title={config.name}
        titleMetadata={titleMetadata}
        backAction={{ content: t("nav.dashboard"), onAction: async () => { await shopify.saveBar.leaveConfirmation(); navigate("/app"); } }}
      >
        <div data-tutorial="tabs">
        <Tabs
          tabs={tabs}
          selected={selectedTabIndex}
          onSelect={handleTabChange}
        />
        </div>
        <div style={{ marginTop: "16px" }}>
          <Outlet />
        </div>
      </Page>

      <Modal
        open={editingName}
        onClose={() => setEditingName(false)}
        title={t("supplier.rename")}
        primaryAction={{
          content: t("common.save"),
          onAction: handleRename,
        }}
        secondaryActions={[
          {
            content: t("common.cancel"),
            onAction: () => setEditingName(false),
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField
              label={t("dashboard.supplierName")}
              value={nameValue}
              onChange={setNameValue}
              autoFocus
              autoComplete="off"
            />
          </FormLayout>
        </Modal.Section>
      </Modal>
    </>
  );
}
