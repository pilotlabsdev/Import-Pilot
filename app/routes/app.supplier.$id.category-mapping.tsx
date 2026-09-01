import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data } from "react-router";

import { useLoaderData, useActionData, Form, useRevalidator } from "react-router";
import { useState, useCallback, useEffect } from "react";
import {
  Banner,
  BlockStack,
  Badge,
  Button,
  Card,
  Checkbox,
  Combobox,
  DataTable,
  Divider,
  FormLayout,
  InlineStack,
  Listbox,
  Modal,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { prisma, getConfigById } from "~/lib/db.server";
import { authenticate, unauthenticated } from "~/shopify.server";
import { getCollections } from "~/lib/collections.server";
import { ViewIcon } from "@shopify/polaris-icons";
import { useTranslation } from "react-i18next";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configId = params.id as string;

  const config = await getConfigById(configId);
  if (!config || config.shopDomain !== shopDomain) throw new Response("Not found", { status: 404 });

  let shopifyCollections: Array<{ id: string; title: string }> = [];
  let shopifyProductTypes: string[] = [];
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    shopifyCollections = await getCollections(admin);
    const ptRes = await admin.graphql(`query { productTypes(first: 1000) { edges { node } } }`);
    const ptJson: any = await ptRes.json();
    shopifyProductTypes = (ptJson.data?.productTypes?.edges || []).map((e: any) => e.node).filter(Boolean);
  } catch (e: any) {
    console.error("[CategoryMapping] Error leyendo colecciones/tipos Shopify:", e?.message);
  }

  const mappings = await prisma.categoryCollectionMapping.findMany({
    where: { shopDomain, configId: config.id },
    orderBy: { csvCategory: "asc" },
  });

  return data({ shopifyCollections, shopifyProductTypes, mappings, shopDomain, configId: config.id });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const configIdParam = params.id as string;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const config = await getConfigById(configIdParam);
  if (!config || config.shopDomain !== shopDomain) throw new Response("Not found", { status: 404 });

  if (intent === "save") {
    const csvCategoriesForm = formData.getAll("csvCategories") as string[];
    const collectionIds = formData.getAll("collectionIds") as string[];
    const collectionNames = formData.getAll("collectionNames") as string[];
    const categoryTags = formData.getAll("categoryTags") as string[];
    const shopifyProductType = (formData.get("shopifyProductType") as string) || null;

    if (csvCategoriesForm.length === 0) {
      return data({ error: "Selecciona al menos una categoría del archivo" });
    }

    await prisma.$transaction(async (tx) => {
      for (const csvCategory of csvCategoriesForm) {
        await tx.categoryCollectionMapping.deleteMany({
          where: { configId: config.id, csvCategory },
        });
      }

      if (collectionIds.length > 0) {
        const allData = csvCategoriesForm.flatMap((csvCategory) =>
          collectionIds.map((cId, i) => ({
            configId: config.id,
            shopDomain,
            csvCategory,
            collectionId: cId,
            collectionName: collectionNames[i] || "",
            shopifyProductType: shopifyProductType || null,
            tags: categoryTags[i] || null,
            isActive: true,
          }))
        );
        await tx.categoryCollectionMapping.createMany({ data: allData });
      }
    });

    return data({ success: true, savedCategory: csvCategoriesForm.join(", ") });
  }

  if (intent === "delete") {
    const id = formData.get("mappingId") as string;
    await prisma.categoryCollectionMapping.delete({ where: { id } });
    return data({ success: true });
  }

  if (intent === "toggle") {
    const id = formData.get("mappingId") as string;
    const current = await prisma.categoryCollectionMapping.findUnique({ where: { id } });
    if (current) {
      await prisma.categoryCollectionMapping.update({
        where: { id },
        data: { isActive: !current.isActive },
      });
    }
    return data({ success: true });
  }

  if (intent === "update") {
    const mappingId = formData.get("mappingId") as string;
    const collectionId = formData.get("collectionId") as string;
    const collectionName = formData.get("collectionName") as string;
    const tags = (formData.get("tags") as string) || null;

    if (!collectionId) {
      return data({ error: "Selecciona una colección" });
    }

    await prisma.categoryCollectionMapping.update({
      where: { id: mappingId },
      data: { collectionId, collectionName, tags },
    });
    return data({ success: true });
  }

  return data({ error: "Acción desconocida" });
};

export default function CategoryMapping() {
  const { shopifyCollections, shopifyProductTypes, mappings, shopDomain, configId } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { error?: string; success?: boolean; savedCategory?: string }
    | undefined;
  const { revalidate } = useRevalidator();
  const { t } = useTranslation();

  useEffect(() => {
    if (actionData?.success) {
      revalidate();
      setSelectedCategories([]);
      setSelectedCollections({});
      setCategoryTags("");
      setSelectedProductType("");
      setCatSearch("");
      setEditingCategory(null);
    } else if (actionData?.error) {
      revalidate();
    }
  }, [actionData]);

  const [csvCategories, setCsvCategories] = useState<string[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [catSearch, setCatSearch] = useState("");
  const [catDropdownOpen, setCatDropdownOpen] = useState(false);
  const [selectedCollections, setSelectedCollections] = useState<Record<string, { id: string; title: string }>>({});
  const [categoryTags, setCategoryTags] = useState("");
  const [selectedProductType, setSelectedProductType] = useState("");
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [previewMapping, setPreviewMapping] = useState<any>(null);
  const [previewItems, setPreviewItems] = useState<any[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewScanned, setPreviewScanned] = useState(0);
  const [previewLimit, setPreviewLimit] = useState(5);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; category: string } | null>(null);

  const loadPreview = useCallback(async (mapping: any, limit = 5) => {
    setPreviewMapping(mapping);
    setPreviewLoading(true);
    setPreviewItems([]);
    setPreviewTotal(0);
    setPreviewScanned(0);
    setPreviewLimit(limit);
    try {
      const params = new URLSearchParams({ configId, mappingId: mapping.id, limit: String(limit), scanLimit: "5000" });
      const res = await fetch(`/api/rule-preview?${params}`);
      const d = await res.json();
      setPreviewItems(d.items || []);
      setPreviewTotal(d.total || 0);
      setPreviewScanned(d.scanned || 0);
    } catch {} finally {
      setPreviewLoading(false);
    }
  }, [configId]);

  const loadMorePreview = useCallback(async () => {
    if (!previewMapping) return;
    const newLimit = previewLimit + 20;
    setPreviewLimit(newLimit);
    setPreviewLoading(true);
    try {
      const params = new URLSearchParams({ configId, mappingId: previewMapping.id, limit: String(newLimit), scanLimit: "5000" });
      const res = await fetch(`/api/rule-preview?${params}`);
      const d = await res.json();
      setPreviewItems(d.items || []);
      setPreviewTotal(d.total || 0);
      setPreviewScanned(d.scanned || 0);
    } catch {} finally {
      setPreviewLoading(false);
    }
  }, [previewMapping, previewLimit, configId]);

  useEffect(() => {
    const loadCategories = async () => {
      try {
        const params = new URLSearchParams({ shop: shopDomain, type: "category", limit: "5000", configId });
        const res = await fetch(`/api/csv-options?${params}`);
        const data = await res.json();
        setCsvCategories((data.options || []).map((o: any) => typeof o === "string" ? o : o.value));
      } catch {
        setCsvCategories([]);
      } finally {
        setLoadingCategories(false);
      }
    };
    loadCategories();
  }, [shopDomain, configId]);

  const toggleCollection = useCallback((id: string, title: string) => {
    setSelectedCollections((prev) => {
      const next = { ...prev };
      if (next[id]) {
        delete next[id];
      } else {
        next[id] = { id, title };
      }
      return next;
    });
  }, []);

  const toggleCategory = useCallback((cat: string) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  }, []);

  const filteredCategories = csvCategories.filter((c) =>
    c.toLowerCase().includes(catSearch.toLowerCase())
  );

  const groupedMappings = mappings.reduce<Record<string, typeof mappings>>((acc, m) => {
    if (!acc[m.csvCategory]) acc[m.csvCategory] = [];
    acc[m.csvCategory].push(m);
    return acc;
  }, {});

  const allCollectionIds = Object.keys(selectedCollections);

  return (
    <>
      <div style={{ paddingBottom: "40px" }}>
      <BlockStack gap="400">
        {actionData?.error && (
          <Banner tone="critical">{actionData.error}</Banner>
        )}
        {actionData?.success && (
          <Banner tone="success">
            {t("categories.saved", { suffix: actionData.savedCategory ? ` de "${actionData.savedCategory}"` : "" })}
          </Banner>
        )}

        {loadingCategories && (
          <Banner tone="info">{t("categories.loadingCategories")}</Banner>
        )}
        {!loadingCategories && csvCategories.length === 0 && (
          <Banner tone="warning">
            {t("categories.noCategories")}
          </Banner>
        )}

        {shopifyCollections.length === 0 && (
          <Banner tone="info">
            {t("categories.noCollections")}
          </Banner>
        )}

        <div data-tutorial="category-page">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              {t("categories.assignTitle")}
            </Text>

            <Form method="post" data-save-bar data-discard-confirmation>
              <FormLayout>
                <input type="hidden" name="intent" value="save" />

                <div data-tutorial="category-combobox">
                <Combobox
                  activator={
                    <Combobox.TextField
                      label={t("categories.fileCategories")}
                      value={selectedCategories.length > 0 ? selectedCategories.join(", ") : catSearch}
                      onChange={(v) => {
                        setCatSearch(v);
                      }}
                      onFocus={() => setCatDropdownOpen(true)}
                      autoComplete="off"
                      placeholder={t("categories.searchCategories")}
                      helpText={t("categories.ofSelected", { selected: selectedCategories.length, total: csvCategories.length })}
                    />
                  }
                  allowMultiple
                  willLoadMoreOptions
                  onScrolledToBottom={() => {}}
                  onClose={() => {
                    setCatDropdownOpen(false);
                    setCatSearch("");
                  }}
                >
                  <Listbox
                    onSelect={(val) => {
                      toggleCategory(val);
                    }}
                  >
                    {filteredCategories.length === 0 && (
                      <Listbox.Option value="" disabled selected={false}>
                        {t("categories.noFound")}
                      </Listbox.Option>
                    )}
                    {filteredCategories.map((cat) => (
                      <Listbox.Option
                        key={cat}
                        value={cat}
                        selected={selectedCategories.includes(cat)}
                      >
                        {cat}
                      </Listbox.Option>
                    ))}
                  </Listbox>
                </Combobox>
                </div>

                {selectedCategories.map((cat) => (
                  <input key={`c-${cat}`} type="hidden" name="csvCategories" value={cat} />
                ))}

                <div data-tutorial="category-collections">
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {t("categories.shopifyCollections")}
                  </Text>
                  {shopifyCollections.length === 0 ? (
                    <Text as="p" tone="subdued">
                      {t("categories.noCollectionsAvailable")}
                    </Text>
                  ) : (
                    <div style={{ maxHeight: "250px", overflowY: "auto", border: "1px solid #ddd", borderRadius: "4px", padding: "8px" }}>
                      {shopifyCollections.map((col) => (
                        <Checkbox
                          key={col.id}
                          label={col.title}
                          checked={!!selectedCollections[col.id]}
                          onChange={() => toggleCollection(col.id, col.title)}
                        />
                      ))}
                    </div>
                  )}
                </BlockStack>
                </div>

                {allCollectionIds.map((cId) => (
                  <input key={`h-${cId}`} type="hidden" name="collectionIds" value={cId} />
                ))}
                {allCollectionIds.map((cId) => (
                  <input
                    key={`n-${cId}`}
                    type="hidden"
                    name="collectionNames"
                    value={selectedCollections[cId]?.title || ""}
                  />
                ))}
                {allCollectionIds.map((cId) => (
                  <input
                    key={`t-${cId}`}
                    type="hidden"
                    name="categoryTags"
                    value={categoryTags}
                  />
                ))}

                <div data-tutorial="category-tags">
                <TextField
                  type="text"
                  label={t("categories.tagsForCategory")}
                  value={categoryTags}
                  onChange={setCategoryTags}
                  autoComplete="off"
                  helpText={t("categories.tagsHelp")}
                />
                </div>

                {shopifyProductTypes.length > 0 && (
                  <div data-tutorial="category-product-type">
                  <Select
                    label={t("categories.shopifyType")}
                    options={[
                      { label: t("categories.useCategoryDefault"), value: "" },
                      ...shopifyProductTypes.map((pt) => ({ label: pt, value: pt })),
                    ]}
                    value={selectedProductType}
                    onChange={setSelectedProductType}
                    helpText={t("categories.typeHelp")}
                  />
                  </div>
                )}
                <input type="hidden" name="shopifyProductType" value={selectedProductType} />

                <Button submit variant="primary" disabled={selectedCategories.length === 0 || allCollectionIds.length === 0}>
                  {t("categories.saveMapping")}
                </Button>
              </FormLayout>
            </Form>
          </BlockStack>
        </Card>
        </div>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              {t("categories.existingMappings", { count: mappings.length })}
            </Text>
            {mappings.length === 0 ? (
              <Text as="p" tone="subdued">
                {t("categories.noMappings")}
              </Text>
            ) : (
              Object.entries(groupedMappings).map(([category, catMappings]) => (
                <BlockStack key={category} gap="200">
                  <Divider />
                  <InlineStack gap="300" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      {category}
                    </Text>
                    {catMappings[0]?.shopifyProductType ? (
                      <Badge tone="success">{t("categories.typeLabel", { type: catMappings[0].shopifyProductType })}</Badge>
                    ) : null}
                  </InlineStack>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {catMappings.map((m) => (
                      <InlineStack key={m.id} gap="200" blockAlign="center">
                        <Text as="span" variant="bodySm">
                          → {m.collectionName || m.collectionId}
                        </Text>
                        {m.tags ? (
                          <Badge tone="info">{m.tags}</Badge>
                        ) : null}
                        <Button size="slim" icon={ViewIcon} onClick={() => loadPreview(m)}>
                          {t("common.view")}
                        </Button>
                        <Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="toggle" />
                          <input type="hidden" name="mappingId" value={m.id} />
                          <Button submit size="slim" variant={m.isActive ? "primary" : "secondary"}>
                            {m.isActive ? t("categories.active") : t("categories.inactive")}
                          </Button>
                        </Form>
                        <Button size="slim" variant="primary" tone="critical" onClick={() => setDeleteConfirm({ id: m.id, category })}>
                          ×
                        </Button>
                      </InlineStack>
                    ))}
                    <Button size="slim" onClick={() => setEditingCategory(category)}>
                      {t("common.edit")}
                    </Button>
                  </div>
                </BlockStack>
              ))
            )}
          </BlockStack>
        </Card>
      </BlockStack>
      </div>
      {editingCategory && (
        <EditCategoryModal
          csvCategory={editingCategory}
          catMappings={groupedMappings[editingCategory] || []}
          shopifyCollections={shopifyCollections}
          shopifyProductTypes={shopifyProductTypes}
          shopDomain={shopDomain}
          onClose={() => setEditingCategory(null)}
        />
      )}
      {previewMapping && (
        <Modal
          open
          onClose={() => setPreviewMapping(null)}
          title={t("categories.preview", { category: previewMapping.csvCategory, collection: previewMapping.collectionName })}
          secondaryActions={[{ content: t("common.close"), onAction: () => setPreviewMapping(null) }]}
        >
          <Modal.Section>
            {previewLoading ? (
              <InlineStack gap="200" blockAlign="center">
                <Spinner size="small" />
                <Text as="p">{t("categories.previewLoading")}</Text>
              </InlineStack>
            ) : previewItems.length === 0 ? (
              <Text as="p" tone="subdued">{t("categories.noProducts")}</Text>
            ) : (
              <>
                <Text as="p" tone="subdued">
                  {t("categories.showingProducts", { count: previewItems.length, total: previewTotal, category: previewMapping.csvCategory })}
                  {previewScanned > 0 && (
                    <> — {t("categories.scannedRows", { count: previewScanned.toLocaleString() })}</>
                  )}
                </Text>
                <DataTable
                  columnContentTypes={["text", "text", "text"]}
                  headings={[t("common.sku"), t("common.name"), t("common.category")]}
                  rows={previewItems.map((item: any) => [
                    <code key={`s-${item.sku}`}>{item.sku}</code>,
                    item.name,
                    item.category,
                  ])}
                />
                {previewItems.length < previewTotal && (
                  <div style={{ marginTop: "12px", textAlign: "center" }}>
                    <Button onClick={loadMorePreview} disabled={previewLoading}>
                      {previewLoading ? t("common.loading") : t("categories.showMore")}
                    </Button>
                  </div>
                )}
              </>
            )}
          </Modal.Section>
        </Modal>
      )}
      {deleteConfirm && (
        <Modal
          open
          onClose={() => setDeleteConfirm(null)}
          title={t("categories.deleteMapping")}
          primaryAction={{
            content: t("common.delete"),
            onAction: () => {
              const form = new FormData();
              form.set("intent", "delete");
              form.set("mappingId", deleteConfirm.id);
              fetch(window.location.href, { method: "POST", body: form });
              setDeleteConfirm(null);
            },
            destructive: true,
          }}
          secondaryActions={[{ content: t("common.cancel"), onAction: () => setDeleteConfirm(null) }]}
        >
          <Modal.Section>
            <Text as="p">
              {t("categories.deleteConfirm", { category: deleteConfirm.category })}
            </Text>
          </Modal.Section>
        </Modal>
      )}
    </>
  );
}

function EditCategoryModal({
  csvCategory,
  catMappings,
  shopifyCollections,
  shopifyProductTypes,
  shopDomain,
  onClose,
}: {
  csvCategory: string;
  catMappings: any[];
  shopifyCollections: Array<{ id: string; title: string }>;
  shopifyProductTypes: string[];
  shopDomain: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [selectedCols, setSelectedCols] = useState<Record<string, string>>(
    Object.fromEntries(catMappings.map((m) => [m.collectionId, m.collectionName || m.collectionId]))
  );
  const [tags, setTags] = useState(catMappings[0]?.tags || "");
  const [productType, setProductType] = useState(catMappings[0]?.shopifyProductType || "");

  const toggleCol = (id: string, title: string) => {
    setSelectedCols((prev) => {
      const next = { ...prev };
      if (next[id]) {
        delete next[id];
      } else {
        next[id] = title;
      }
      return next;
    });
  };

  const colIds = Object.keys(selectedCols);

  return (
    <Modal
      open
      onClose={onClose}
      title={`${t("common.edit")}: ${csvCategory}`}
      primaryAction={{
        content: t("common.save"),
        onAction: () => {
          const form = document.getElementById(`edit-cat-form-${csvCategory}`) as HTMLFormElement;
          if (form) form.requestSubmit();
        },
      }}
      secondaryActions={[{ content: t("common.cancel"), onAction: onClose }]}
    >
      <Modal.Section>
        <Form id={`edit-cat-form-${csvCategory}`} method="post">
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="csvCategories" value={csvCategory} />
          {colIds.map((cId) => (
            <input key={`h-${cId}`} type="hidden" name="collectionIds" value={cId} />
          ))}
          {colIds.map((cId) => (
            <input key={`n-${cId}`} type="hidden" name="collectionNames" value={selectedCols[cId]} />
          ))}
          {colIds.map(() => (
            <input key={`t-${csvCategory}`} type="hidden" name="categoryTags" value={tags} />
          ))}
          <input type="hidden" name="shopifyProductType" value={productType} />
          <FormLayout>
            <Text as="p" variant="bodyMd">
              {t("categories.categoryLabel", { category: csvCategory })}
            </Text>

            <BlockStack gap="200">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {t("categories.shopifyCollections")}
              </Text>
              {shopifyCollections.length === 0 ? (
                <Text as="p" tone="subdued">
                  {t("categories.noCollectionsAvailable")}
                </Text>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px" }}>
                  {shopifyCollections.map((col) => (
                    <Checkbox
                      key={col.id}
                      label={col.title}
                      checked={!!selectedCols[col.id]}
                      onChange={() => toggleCol(col.id, col.title)}
                    />
                  ))}
                </div>
              )}
            </BlockStack>

            <TextField
              label="Tags"
              value={tags}
              onChange={setTags}
              autoComplete="off"
              helpText={t("categories.tagsComma")}
            />

            {shopifyProductTypes.length > 0 && (
              <Select
                label={t("categories.shopifyType")}
                options={[
                  { label: t("categories.useCsvDefault"), value: "" },
                  ...shopifyProductTypes.map((pt) => ({ label: pt, value: pt })),
                ]}
                value={productType}
                onChange={setProductType}
                helpText={t("categories.typeCsvHelp")}
              />
            )}
          </FormLayout>
        </Form>
      </Modal.Section>
    </Modal>
  );
}
