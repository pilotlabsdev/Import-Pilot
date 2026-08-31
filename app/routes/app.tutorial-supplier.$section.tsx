import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useLocation, useNavigate } from "react-router";
import {
  Page,
  Tabs,
  Text,
  Card,
  BlockStack,
  Badge,
  Select,
  TextField,
  Checkbox,
  DataTable,
  InlineStack,
  Button,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { useTranslation } from "react-i18next";

const MOCK_CONFIG_BASE = { id: "tutorial-mock", shopDomain: "tutorial" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return data({ config: MOCK_CONFIG_BASE });
};

function ImportMock() {
  const { t } = useTranslation();

  const SUPPLIER_TABS = [
    { id: "import", content: t('supplier.import') },
    { id: "config", content: t('supplier.config') },
    { id: "columns", content: t('supplier.columns') },
    { id: "price-rules", content: t('supplier.priceRules') },
    { id: "category-mapping", content: t('supplier.categories') },
    { id: "preview", content: t('supplier.preview') },
    { id: "logs", content: t('supplier.history') },
  ];

  return (
    <BlockStack gap="400">
      <div data-tutorial="import-page">
      <div data-tutorial="import-run-btn">
        <Button variant="primary" disabled>{t('import.run')}</Button>
      </div>
      <Text as="p" tone="subdued">{t('import.runTooltip')}</Text>

      <div data-tutorial="import-filters">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t('tutorial.importFilters')}</Text>
            <Checkbox label={t('preview.allProducts')} checked disabled />
            <Checkbox label={t('preview.bySku')} disabled />
            <Checkbox label={t('preview.byCategories')} disabled />
          </BlockStack>
        </Card>
      </div>

      <div data-tutorial="import-stats">
        <InlineStack gap="300" wrap>
          <Card><BlockStack gap="100"><Text as="h2" variant="headingLg">1.247</Text><Text as="p" tone="subdued">{t('preview.totalRows')}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="h2" variant="headingLg">892</Text><Text as="p" tone="subdued">{t('common.created')}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="h2" variant="headingLg">355</Text><Text as="p" tone="subdued">{t('common.updated')}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="h2" variant="headingLg">0</Text><Text as="p" tone="subdued">{t('common.errors')}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="h2" variant="headingLg">12</Text><Text as="p" tone="subdued">{t('common.excluded')}</Text></BlockStack></Card>
        </InlineStack>
      </div>

      <div data-tutorial="import-cron">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">{t('tutorial.scheduledImport')}</Text>
            <InlineStack gap="300" blockAlign="center">
              <Text as="p">
                <strong>{t('common.status')}:</strong>{" "}
                <Badge tone="success">{t('common.active')}</Badge>
              </Text>
              <Button size="slim" disabled>{t('import.stopCron')}</Button>
            </InlineStack>
            <Text as="p" tone="subdued">
              {t('import.runsAt', { frequency: t('frequency.every6h') })}
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">{t('import.configStatus')}</Text>
            <InlineStack gap="200" wrap>
              <Text as="p"><strong>{t('config.frequency')}:</strong> {t('frequency.every6h')}</Text>
              <Text as="p"><strong>{t('config.importMode')}:</strong> {t('common.bulkOperation')}</Text>
              <Text as="p"><strong>{t('import.lastImport')}:</strong> {t("tutorialMock.dateFull")}</Text>
            </InlineStack>
            <InlineStack gap="200">
              <Text as="p" tone="subdued">{t('import.lastStatus')}:</Text>
              <Badge tone="success">{t('common.completed')}</Badge>
            </InlineStack>
          </BlockStack>
        </Card>
      </div>

      <div data-tutorial="import-actions">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">{t('common.actions')}</Text>
            <InlineStack gap="200" wrap>
              <Button disabled>{t('supplier.preview')}</Button>
              <Button disabled>{t('supplier.config')}</Button>
              <Button disabled>{t('supplier.columns')}</Button>
              <Button disabled>{t('supplier.priceRules')}</Button>
              <Button disabled>{t('supplier.categories')}</Button>
              <Button disabled>{t('supplier.history')}</Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </div>
      </div>

      <div data-tutorial="import-history">
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">{t('tutorial.historyTitle')}</Text>
          <DataTable
            columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "numeric", "numeric"]}
            headings={[t('common.startDate'), t('common.status'), t('common.total'), t('common.created'), t('common.updated'), t('common.excluded'), t('common.errors')]}
            rows={[
              ["27/08/2026 10:30", t('common.completed'), "1247", "892", "355", "12", "0"],
              ["26/08/2026 22:00", t('common.completed'), "1247", "15", "1247", "0", "0"],
              ["26/08/2026 16:00", t('common.failed'), "0", "0", "0", "0", "3"],
            ]}
          />
        </BlockStack>
      </Card>
      </div>
    </BlockStack>
  );
}

function ConfigMock() {
  const { t } = useTranslation();

  const UPDATE_OPTIONS = [
    t('config.fieldName'),
    t('config.fieldDescription'),
    t('config.fieldPrice'),
    t('config.fieldStock'),
    t('config.fieldImages'),
    t('config.fieldBrand'),
    t('config.fieldProductType'),
    t('config.fieldTags'),
    t('config.fieldMetafields'),
    t('config.fieldCollections'),
  ];

  return (
    <BlockStack gap="400">
      <div data-tutorial="datasource-card">
        <Card>
          <BlockStack gap="400">
            <Text as="h3" variant="headingSm">{t('config.dataSource')}</Text>
            <div data-tutorial="url-toggle">
              <Tabs tabs={[{ id: "url", content: t('config.remoteUrl') }, { id: "file", content: t('config.uploadedFile') }]} selected={0} disabled />
            </div>
            <TextField label={t('config.urlLabel')} value={t("tutorialMock.exampleUrl")} autoComplete="off" disabled helpText={t('config.urlHelp')} />
            <div style={{ display: "flex", gap: "16px" }}>
              <div style={{ flex: 1 }} data-tutorial="delimiter-select">
                <Select label={t('config.delimiter')} options={[{ label: t('config.autoDetect'), value: "auto" }, { label: t('config.pipe'), value: "|" }, { label: t('config.comma'), value: "," }, { label: t('config.semicolon'), value: ";" }, { label: t('config.tab'), value: "\t" }]} value="auto" disabled />
              </div>
              <div style={{ flex: 1 }} data-tutorial="frequency-select">
                <Select label={t('config.frequency')} options={[{ label: t('frequency.every30min'), value: "30min" }, { label: t('frequency.hourly'), value: "hourly" }, { label: t('frequency.every2h'), value: "2h" }, { label: t('frequency.every3h'), value: "3h" }, { label: t('frequency.every4h'), value: "4h" }, { label: t('frequency.every6h'), value: "6h" }, { label: t('frequency.every12h'), value: "12h" }, { label: t('frequency.daily'), value: "daily" }, { label: t('frequency.weekly'), value: "weekly" }]} value="6h" disabled />
              </div>
            </div>
            <div style={{ display: "flex", gap: "16px" }}>
              <div style={{ flex: 1 }} data-tutorial="product-status-select">
                <Select label={t('config.productStatus')} options={[{ label: t('common.draft'), value: "DRAFT" }, { label: t('common.active'), value: "ACTIVE" }]} value="DRAFT" disabled />
              </div>
              <div style={{ flex: 1 }} data-tutorial="import-mode-select">
                <Select label={t('config.importMode')} options={[{ label: t('common.chunks'), value: "chunks" }, { label: t('common.bulkOperation'), value: "bulk" }]} value="bulk" disabled helpText={t('config.bulkDescription')} />
              </div>
            </div>
            <div style={{ display: "flex", gap: "16px" }}>
              <div style={{ flex: 1 }} data-tutorial="chunk-size">
                <TextField label={t('config.batchSize')} value="50" autoComplete="off" disabled helpText={t('config.batchSizeHelp') + " " + t('config.maxBatch')} />
              </div>
              <div style={{ flex: 1 }} data-tutorial="max-retries">
                <TextField label={t('config.retries')} value="3" autoComplete="off" disabled helpText={t('config.maxRetries')} />
              </div>
            </div>
          </BlockStack>
        </Card>
      </div>

      <div data-tutorial="update-options">
        <Card>
          <BlockStack gap="200">
            <Checkbox
              label={t('config.updateFields')}
              checked
              disabled
              helpText={t('config.updateFieldsHelp')}
            />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px" }}>
              {UPDATE_OPTIONS.map((opt) => (
                <Checkbox key={opt} label={opt} checked={[t('config.fieldName'), t('config.fieldDescription'), t('config.fieldPrice'), t('config.fieldStock'), t('config.fieldTags')].includes(opt)} disabled />
              ))}
            </div>
          </BlockStack>
        </Card>
      </div>

      <div data-tutorial="default-tags">
        <TextField label={t('config.defaultTags')} value={t("tutorialMock.importedTags")} autoComplete="off" disabled helpText={t('config.defaultTagsHelp')} />
      </div>

      <Checkbox label={t('config.noStockZero')} disabled />

      <div data-tutorial="channels">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">{t('config.salesChannels')}</Text>
            <Text as="p" tone="subdued">{t('config.salesChannelsHelp')}</Text>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px" }}>
              <Checkbox label="Online Store" checked disabled />
              <Checkbox label="Point of Sale" disabled />
            </div>
          </BlockStack>
        </Card>
      </div>

      <div data-tutorial="exclusions-card">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t('config.exclusions')}</Text>
            <Text as="p" tone="subdued">{t('config.exclusionsHelp')}</Text>
            <TextField label={t('config.excludeTitle')} value={t("tutorialMock.outletWords")} autoComplete="off" disabled helpText={t('config.excludeTitleHelp')} />
            <TextField label={t('config.excludeSku')} value={t("tutorialMock.outletSku")} autoComplete="off" disabled helpText={t('config.excludeSkuHelp')} />
            <TextField label={t('config.excludeEan')} placeholder={t('common.noResults')} autoComplete="off" disabled />
            <Text as="p" fontWeight="semibold">{t('config.excludeFieldRules')}</Text>
            <div style={{ padding: "8px", background: "#f6f6f7", borderRadius: "4px" }}>
              <Text as="p" tone="subdued">{t('config.excludeSkuExample')}</Text>
            </div>
          </BlockStack>
        </Card>
      </div>

      <div data-tutorial="location-select">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">{t('config.inventoryLocation')}</Text>
            <Text as="p" tone="subdued">{t('config.inventoryLocationHelp')}</Text>
            <Badge tone="success">{t('config.usingDefault')}</Badge>
          </BlockStack>
        </Card>
      </div>
    </BlockStack>
  );
}

function ColumnsMock() {
  const { t } = useTranslation();

  const FIELDS = [
    { label: t('columns.fieldTitle'), csv: "name", default: "" },
    { label: t('columns.fieldSku'), csv: "sku", default: "" },
    { label: t('columns.fieldEan'), csv: "ean", default: "" },
    { label: t('columns.fieldDescription'), csv: "description", default: "" },
    { label: t('columns.fieldShortDesc'), csv: "short_description", default: "" },
    { label: t('columns.fieldPrice'), csv: "price", default: "" },
    { label: t('columns.fieldQuantity'), csv: "quantity", default: "" },
    { label: t('columns.fieldCategory'), csv: "category", default: "" },
    { label: t('columns.fieldVendor'), csv: "brand", default: "" },
    { label: t('columns.fieldProductType'), csv: "product_type", default: "" },
    { label: t('columns.fieldWeight'), csv: "weight", default: "" },
    { label: t('columns.fieldImage1'), csv: "image1", default: "" },
  ];
  return (
    <BlockStack gap="400">
      <Text as="p" tone="subdued">{t('columns.columnsDetected', { count: 12 })}</Text>
      <div data-tutorial="columns-page">
        <Card padding="0">
          {FIELDS.map((f, i) => (
            <div key={f.label} style={{ display: "flex", gap: "12px", alignItems: "center", padding: "12px 16px", borderBottom: i < FIELDS.length - 1 ? "1px solid #e1e3e5" : undefined }}>
              <span style={{ width: "180px", fontWeight: 500, fontSize: "14px" }}>{f.label}</span>
              <div style={{ flex: 1 }} {...(f.label === t('columns.fieldTitle') ? { "data-tutorial": "column-select-example" } : {})}>
                <div style={{ padding: "6px 8px", border: "1px solid #c9ccd1", borderRadius: "4px", fontSize: "14px" }}>{f.csv}</div>
              </div>
              <div style={{ width: "200px" }} {...(f.label === t('columns.fieldTitle') ? { "data-tutorial": "column-default-example" } : {})}>
                <div style={{ padding: "6px 8px", border: "1px solid #e1e3e5", borderRadius: "4px", fontSize: "14px", color: "#8c9196" }}>{t('columns.noDefault')}</div>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </BlockStack>
  );
}

function PriceRulesMock() {
  const { t } = useTranslation();
  return (
    <BlockStack gap="400">
      <div data-tutorial="price-rules-page">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t('priceRules.newRule')}</Text>
            <TextField label={t('common.name')} placeholder={t('priceRules.ruleName')} autoComplete="off" disabled />
            <Select label={t('tutorial.ruleType')} options={[{ label: t('priceRules.general'), value: "general" }, { label: t('priceRules.byCategory'), value: "category" }, { label: t('priceRules.bySku'), value: "sku" }]} value="general" disabled />
            <div data-tutorial="price-formula">
              <TextField label={t('priceRules.formula')} value="C*1.262" autoComplete="off" disabled helpText={t('priceRules.formulaHelp')} />
            </div>
            <div data-tutorial="price-rounding">
              <Select label={t('priceRules.rounding')} options={[{ label: t('priceRules.noRounding'), value: "none" }, { label: t('priceRules.round95'), value: ".95" }, { label: t('priceRules.round99'), value: ".99" }, { label: t('priceRules.customRound'), value: "custom" }]} value=".95" disabled />
            </div>
            <div data-tutorial="price-compare">
              <Select label={t('priceRules.compareAt')} options={[{ label: t('priceRules.compareC'), value: "cost" }, { label: t('priceRules.compareX'), value: "regular" }]} value="cost" disabled />
              <Select label={t('priceRules.compareType')} options={[{ label: t('priceRules.compareFormula'), value: "formula" }, { label: t('priceRules.compareFixed'), value: "fixed" }, { label: t('priceRules.comparePercent'), value: "percentage" }]} value="formula" disabled />
              <TextField label={t('priceRules.compareFormulaLabel')} value="C*1.5" autoComplete="off" disabled />
              <Select label={t('priceRules.compareRounding')} options={[{ label: t('priceRules.noRounding'), value: "none" }, { label: t('priceRules.round95'), value: ".95" }, { label: t('priceRules.round99'), value: ".99" }]} value=".95" disabled />
            </div>
            <Button variant="primary" disabled>{t('priceRules.createRule')}</Button>
          </BlockStack>
        </Card>
      </div>

      <div data-tutorial="price-existing">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">{t('priceRules.existingRules')}</Text>
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text", "text"]}
              headings={[t('common.name'), t('priceRules.formula'), t('priceRules.compareAt'), t('priceRules.rounding'), t('common.status'), t('common.actions')]}
              rows={[
                [
                  t('priceRules.generalRule'),
                  "C*1.262",
                  "C*1.5",
                  ".95",
                  <Button key="on" size="slim" variant="primary" disabled>{t('priceRules.yes')}</Button>,
                  <span key="actions" style={{ display: "inline-flex", gap: "4px" }}>
                    <Button key="ver" size="slim" disabled>{t('common.view')}</Button>
                    <Button key="edit" size="slim" disabled>{t('common.edit')}</Button>
                    <Button key="del" size="slim" tone="critical" disabled>{t('common.delete')}</Button>
                  </span>,
                ],
                [
                  t('priceRules.outlet'),
                  "C*1.1",
                  "—",
                  t('priceRules.noRounding'),
                  <Button key="off" size="slim" variant="secondary" disabled>{t('priceRules.no')}</Button>,
                  <span key="actions" style={{ display: "inline-flex", gap: "4px" }}>
                    <Button key="ver" size="slim" disabled>{t('common.view')}</Button>
                    <Button key="edit" size="slim" disabled>{t('common.edit')}</Button>
                    <Button key="del" size="slim" tone="critical" disabled>{t('common.delete')}</Button>
                  </span>,
                ],
                [
                  "PROD-SKU-001",
                  "C+5",
                  "C*2",
                  ".99",
                  <Button key="on2" size="slim" variant="primary" disabled>{t('priceRules.yes')}</Button>,
                  <span key="actions" style={{ display: "inline-flex", gap: "4px" }}>
                    <Button key="ver" size="slim" disabled>{t('common.view')}</Button>
                    <Button key="edit" size="slim" disabled>{t('common.edit')}</Button>
                    <Button key="del" size="slim" tone="critical" disabled>{t('common.delete')}</Button>
                  </span>,
                ],
              ]}
            />
          </BlockStack>
        </Card>
      </div>
    </BlockStack>
  );
}

function CategoryMappingMock() {
  const { t } = useTranslation();
  return (
    <BlockStack gap="400">
      <div data-tutorial="category-page">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t('categories.assignTitle')}</Text>
            <div data-tutorial="category-combobox">
              <TextField label={t('categories.fileCategories')} value={t("tutorialMock.categories")} autoComplete="off" disabled helpText={`${4} ${t('categories.ofSelected')}`} />
            </div>
            <div data-tutorial="category-collections">
              <Text as="p" fontWeight="semibold">{t('categories.shopifyCollections')}</Text>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px" }}>
                <Checkbox label={t("tutorialMock.collectionTech")} checked disabled />
                <Checkbox label={t("tutorialMock.collectionHome")} checked disabled />
                <Checkbox label={t("tutorialMock.collectionAcc")} disabled />
                <Checkbox label={t("tutorialMock.collectionOffers")} disabled />
                <Checkbox label={t("tutorialMock.collectionNew")} disabled />
              </div>
            </div>
            <div data-tutorial="category-tags">
              <TextField label={t('categories.tagsForCategory')} value={t("tutorialMock.techTags")} autoComplete="off" disabled helpText={t('categories.tagsHelp')} />
            </div>
            <div data-tutorial="category-product-type">
              <Select label={t('categories.shopifyType')} options={[{ label: t('categories.useCategoryDefault'), value: "" }, { label: t("tutorialMock.collectionTech"), value: "Electrónica" }, { label: t("tutorialMock.collectionHome"), value: "Hogar" }]} value="" disabled helpText={t('categories.typeHelp')} />
            </div>
            <Button variant="primary" disabled>{t('categories.saveMapping')}</Button>
          </BlockStack>
        </Card>
      </div>

      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">{t('categories.existingMappings', { count: 2 })}</Text>
          <div style={{ padding: "12px", border: "1px solid #e1e3e5", borderRadius: "4px" }}>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" fontWeight="semibold">{t("tutorialMock.collectionTech")}</Text>
              <InlineStack gap="100">
                <Badge>{t("tutorialMock.collectionTech")}</Badge>
                <Badge>{t("tutorialMock.collectionHome")}</Badge>
              </InlineStack>
            </InlineStack>
            <Text as="p" tone="subdued">{t("tutorialMock.skuLabel")}: {t("tutorialMock.techTags")}</Text>
          </div>
          <div style={{ padding: "12px", border: "1px solid #e1e3e5", borderRadius: "4px" }}>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" fontWeight="semibold">{t("tutorialMock.collectionAcc")}</Text>
              <InlineStack gap="100">
                <Badge>{t("tutorialMock.collectionAcc")}</Badge>
              </InlineStack>
            </InlineStack>
            <Text as="p" tone="subdued">{t("tutorialMock.skuLabel")}: {t("tutorialMock.accTags")}</Text>
          </div>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

function PreviewMock() {
  const { t } = useTranslation();
  return (
    <BlockStack gap="400">
      <div data-tutorial="preview-page">
      <div data-tutorial="preview-filters">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t('preview.filterProducts')}</Text>
            <Checkbox label={t('preview.allProducts')} checked disabled />
            <Checkbox label={t('preview.bySku')} disabled />
            <Checkbox label={t('preview.byCategories')} disabled />
            <Button variant="primary" disabled>{t('preview.updatePreview')}</Button>
          </BlockStack>
        </Card>
      </div>

      <div data-tutorial="preview-stats">
        <InlineStack gap="300" wrap>
          <Card><BlockStack gap="100"><Text as="p" variant="headingXl" alignment="center">1.247</Text><Text as="p" variant="bodySm" tone="subdued" alignment="center">{t('preview.totalRows')}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="p" variant="headingXl" alignment="center">892</Text><Text as="p" variant="bodySm" tone="subdued" alignment="center">{t('preview.toCreate')}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="p" variant="headingXl" alignment="center">355</Text><Text as="p" variant="bodySm" tone="subdued" alignment="center">{t('preview.toUpdate')}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="p" variant="headingXl" alignment="center">0</Text><Text as="p" variant="bodySm" tone="subdued" alignment="center">{t('common.unchanged')}</Text></BlockStack></Card>
          <Card><BlockStack gap="100"><Text as="p" variant="headingXl" alignment="center">12</Text><Text as="p" variant="bodySm" tone="subdued" alignment="center">{t('common.excluded')}</Text></BlockStack></Card>
        </InlineStack>
      </div>

      <div data-tutorial="preview-table">
        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text", "numeric", "numeric", "numeric", "numeric", "numeric", "text", "text"]}
            headings={[t('common.sku'), t('common.name'), t('preview.action'), t('preview.cost'), t('common.price'), t('preview.comparison'), t('preview.stockCsv'), t('preview.stockShopify'), t('common.category'), t('common.errors')]}
            rows={[
              ["PROD-001", t("tutorialMock.product1"), t('preview.createAction'), "25.00", "31.55", "37.50", "100", "0", t("tutorialMock.collectionTech"), ""],
              ["PROD-002", t("tutorialMock.product2"), t('preview.updateAction'), "12.50", "15.78", "18.75", "50", "45", t("tutorialMock.collectionAcc"), ""],
              ["PROD-003", t("tutorialMock.product3"), t('preview.createAction'), "89.00", "112.32", "133.50", "25", "0", t("tutorialMock.collectionTech"), ""],
              ["PROD-OUT-001", t("tutorialMock.product4"), t('preview.excludeAction'), "15.00", "—", "—", "30", "0", t("tutorialMock.collectionAcc"), t('preview.excludedBySku')],
              ["PROD-005", t("tutorialMock.product5"), t('preview.unchangedAction'), "35.00", "44.17", "52.50", "20", "20", t("tutorialMock.collectionHome"), ""],
            ]}
          />
        </Card>
      </div>

      <InlineStack gap="200" align="center">
        <Button disabled>← {t('common.previous')}</Button>
        <Text as="p">{t('preview.pagination', { page: 1, totalPages: 5 })}</Text>
        <Button disabled>{t('common.next')} →</Button>
      </InlineStack>
      </div>
    </BlockStack>
  );
}

function LogsMock() {
  const { t } = useTranslation();
  return (
    <BlockStack gap="400">
      <div data-tutorial="logs-page">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">{t('tutorial.historyTitle')}</Text>
            <div data-tutorial="logs-table">
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric"]}
                headings={[t('common.startDate'), t('common.endDate'), t('common.status'), t('common.trigger'), t('common.total'), t('common.created'), t('common.updated'), t('common.unchanged'), t('queue.priceDown'), t('queue.stockDown'), t('common.errors')]}
                rows={[
                  ["27/08/2026 10:30", "27/08/2026 10:35", t('common.completed'), t('common.manual'), "1247", "892", "355", "0", "12", "5", "0"],
                  ["26/08/2026 22:00", "26/08/2026 22:02", t('common.completed'), t("tutorialMock.cron"), "1247", "15", "1247", "0", "0", "3", "0"],
                  ["26/08/2026 16:00", "26/08/2026 16:00", t('common.failed'), t('common.manual'), "0", "0", "0", "0", "0", "0", "3"],
                  ["25/08/2026 10:00", "25/08/2026 10:04", t('common.completed'), t("tutorialMock.cron"), "1247", "0", "1247", "0", "0", "0", "0"],
                  ["24/08/2026 22:00", "24/08/2026 22:03", t('common.completed'), t("tutorialMock.cron"), "1200", "0", "1200", "0", "0", "0", "0"],
                ]}
              />
            </div>
          </BlockStack>
        </Card>
      </div>
    </BlockStack>
  );
}

const SECTION_CONTENT: Record<string, () => JSX.Element> = {
  import: ImportMock,
  config: ConfigMock,
  columns: ColumnsMock,
  "price-rules": PriceRulesMock,
  "category-mapping": CategoryMappingMock,
  preview: PreviewMock,
  logs: LogsMock,
};

export default function TutorialSupplierPage() {
  const { config } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const SUPPLIER_TABS = [
    { id: "import", content: t('supplier.import') },
    { id: "config", content: t('supplier.config') },
    { id: "columns", content: t('supplier.columns') },
    { id: "price-rules", content: t('supplier.priceRules') },
    { id: "category-mapping", content: t('supplier.categories') },
    { id: "preview", content: t('supplier.preview') },
    { id: "logs", content: t('supplier.history') },
  ];

  const pathParts = location.pathname.split("/");
  const currentSection = pathParts[pathParts.length - 1] || "import";
  const tabIndex = SUPPLIER_TABS.findIndex((tab) => tab.id === currentSection);

  const handleTabChange = (_index: number) => {
    // Tabs are disabled during tutorial to prevent navigation away
  };

  const SectionContent = SECTION_CONTENT[currentSection] || ImportMock;

  return (
    <Page
      title={t("tutorialMock.exampleSupplier")}
      titleMetadata={<Badge tone="info">{t('nav.tutorial')}</Badge>}
      backAction={{ content: t('nav.tutorial'), onAction: () => navigate("/app/tutorial") }}
    >
      <div data-tutorial="tabs">
      <Tabs
        tabs={SUPPLIER_TABS.map((tab) => ({ id: tab.id, content: tab.content }))}
        selected={tabIndex >= 0 ? tabIndex : 0}
        onSelect={handleTabChange}
      />
      </div>
      <div style={{ paddingTop: "16px" }}>
        <SectionContent />
      </div>
    </Page>
  );
}
