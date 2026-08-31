export interface TutorialStep {
  id: string;
  page: string;
  element: string;
  title: string;
  description: string;
  side?: "top" | "bottom" | "left" | "right";
  showButtons?: boolean;
  isPageIntro?: boolean;
}

export const TUTORIAL_PAGES = [
  { id: "dashboard", label: "tutorial.stepDashboard", route: "/app/tutorial/dashboard" },
  { id: "import", label: "tutorial.stepImport", route: "/app/tutorial/supplier/import" },
  { id: "config", label: "tutorial.stepConfig", route: "/app/tutorial/supplier/config" },
  { id: "columns", label: "tutorial.stepColumns", route: "/app/tutorial/supplier/columns" },
  { id: "price-rules", label: "tutorial.stepPriceRules", route: "/app/tutorial/supplier/price-rules" },
  { id: "category-mapping", label: "tutorial.stepCategories", route: "/app/tutorial/supplier/category-mapping" },
  { id: "preview", label: "tutorial.stepPreview", route: "/app/tutorial/supplier/preview" },
  { id: "logs", label: "tutorial.stepHistory", route: "/app/tutorial/supplier/logs" },
  { id: "settings", label: "tutorial.stepSettings", route: "/app/tutorial/settings" },
  { id: "duplicates", label: "tutorial.stepDuplicates", route: "/app/tutorial/duplicates" },
  { id: "queue", label: "tutorial.stepQueue", route: "/app/tutorial/queue" },
] as const;

export const TUTORIAL_STEPS: TutorialStep[] = [
  // ═══════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════
  {
    id: "dashboard-intro",
    page: "dashboard",
    element: '[data-tutorial="page-title"], .Polaris-Page__Title, h1',
    title: "tutorial.dashboardTitle",
    description: "tutorial.dashboardDescription",
    side: "bottom",
    isPageIntro: true,
  },
  {
    id: "dashboard-new-supplier",
    page: "dashboard",
    element: '.Polaris-Page-Header__PrimaryActionWrapper button',
    title: "tutorial.newSupplier",
    description: "tutorial.newSupplierDescription",
    side: "left",
  },
  {
    id: "dashboard-supplier-list",
    page: "dashboard",
    element: '[data-tutorial="supplier-list"]',
    title: "tutorial.supplierList",
    description: "tutorial.supplierListDescription",
    side: "bottom",
  },
  {
    id: "dashboard-configure-btn",
    page: "dashboard",
    element: '[data-tutorial="configure-btn"]',
    title: "tutorial.configureSupplier",
    description: "tutorial.configureSupplierDescription",
    side: "left",
  },
  {
    id: "dashboard-history-btn",
    page: "dashboard",
    element: '[data-tutorial="history-btn"]',
    title: "tutorial.importHistory",
    description: "tutorial.importHistoryDescription",
    side: "left",
  },
  {
    id: "dashboard-delete-btn",
    page: "dashboard",
    element: '[data-tutorial="delete-btn"]',
    title: "tutorial.deleteSupplier",
    description: "tutorial.deleteSupplierDescription",
    side: "left",
  },

  // ═══════════════════════════════════════════
  // SUPPLIER DETAIL — TABS (shown on import page)
  // ═══════════════════════════════════════════
  {
    id: "supplier-tabs-intro",
    page: "import",
    element: '[data-tutorial="tabs"]',
    title: "tutorial.supplierTabs",
    description: "tutorial.supplierTabsDescription",
    side: "bottom",
    isPageIntro: true,
  },

  // ═══════════════════════════════════════════
  // IMPORTAR
  // ═══════════════════════════════════════════

  // ═══════════════════════════════════════════
  // CONFIGURACIÓN
  // ═══════════════════════════════════════════
  {
    id: "config-datasource",
    page: "config",
    element: '[data-tutorial="datasource-card"]',
    title: "tutorial.dataSource",
    description: "tutorial.dataSourceDescription",
    side: "bottom",
    isPageIntro: true,
  },
  {
    id: "config-url-mode",
    page: "config",
    element: '[data-tutorial="url-toggle"]',
    title: "tutorial.remoteMode",
    description: "tutorial.remoteModeDescription",
    side: "bottom",
  },
  {
    id: "config-delimiter",
    page: "config",
    element: '[data-tutorial="delimiter-select"]',
    title: "tutorial.delimiter",
    description: "tutorial.delimiterDescription",
    side: "right",
  },
  {
    id: "config-frequency",
    page: "config",
    element: '[data-tutorial="frequency-select"]',
    title: "tutorial.frequency",
    description: "tutorial.frequencyDescription",
    side: "right",
  },
  {
    id: "config-product-status",
    page: "config",
    element: '[data-tutorial="product-status-select"]',
    title: "tutorial.productStatus",
    description: "tutorial.productStatusDescription",
    side: "right",
  },
  {
    id: "config-import-mode",
    page: "config",
    element: '[data-tutorial="import-mode-select"]',
    title: "tutorial.importMode",
    description: "tutorial.importModeDescription",
    side: "right",
  },
  {
    id: "config-chunk-size",
    page: "config",
    element: '[data-tutorial="chunk-size"]',
    title: "tutorial.batchSize",
    description: "tutorial.batchSizeDescription",
    side: "right",
  },
  {
    id: "config-max-retries",
    page: "config",
    element: '[data-tutorial="max-retries"]',
    title: "tutorial.retries",
    description: "tutorial.retriesDescription",
    side: "right",
  },
  {
    id: "config-update-options",
    page: "config",
    element: '[data-tutorial="update-options"]',
    title: "tutorial.updateFields",
    description: "tutorial.updateFieldsDescription",
    side: "bottom",
  },
  {
    id: "config-default-tags",
    page: "config",
    element: '[data-tutorial="default-tags"]',
    title: "tutorial.defaultTags",
    description: "tutorial.defaultTagsDescription",
    side: "right",
  },
  {
    id: "config-channels",
    page: "config",
    element: '[data-tutorial="channels"]',
    title: "tutorial.salesChannels",
    description: "tutorial.salesChannelsDescription",
    side: "bottom",
  },
  {
    id: "config-exclusions",
    page: "config",
    element: '[data-tutorial="exclusions-card"]',
    title: "tutorial.exclusions",
    description: "tutorial.exclusionsDescription",
    side: "top",
  },
  {
    id: "config-location",
    page: "config",
    element: '[data-tutorial="location-select"]',
    title: "tutorial.inventoryLocation",
    description: "tutorial.inventoryLocationDescription",
    side: "top",
  },

  // ═══════════════════════════════════════════
  // MAPEO DE COLUMNAS
  // ═══════════════════════════════════════════
  {
    id: "columns-intro",
    page: "columns",
    element: '[data-tutorial="columns-page"]',
    title: "tutorial.columnMapping",
    description: "tutorial.columnMappingDescription",
    side: "bottom",
    isPageIntro: true,
  },
  {
    id: "columns-select",
    page: "columns",
    element: '[data-tutorial="column-select-example"]',
    title: "tutorial.selectColumn",
    description: "tutorial.selectColumnDescription",
    side: "right",
  },
  {
    id: "columns-default",
    page: "columns",
    element: '[data-tutorial="column-default-example"]',
    title: "tutorial.defaultValue",
    description: "tutorial.defaultValueDescription",
    side: "right",
  },

  // ═══════════════════════════════════════════
  // REGLAS DE PRECIO
  // ═══════════════════════════════════════════
  {
    id: "price-intro",
    page: "price-rules",
    element: '[data-tutorial="price-rules-page"]',
    title: "tutorial.priceRulesTitle",
    description: "tutorial.priceRulesDescription",
    side: "bottom",
    isPageIntro: true,
  },
  {
    id: "price-type",
    page: "price-rules",
    element: '[data-tutorial="price-type-select"]',
    title: "tutorial.ruleType",
    description: "tutorial.ruleTypeDescription",
    side: "right",
  },
  {
    id: "price-formula",
    page: "price-rules",
    element: '[data-tutorial="price-formula"]',
    title: "tutorial.priceFormula",
    description: "tutorial.priceFormulaDescription",
    side: "right",
  },
  {
    id: "price-rounding",
    page: "price-rules",
    element: '[data-tutorial="price-rounding"]',
    title: "tutorial.rounding",
    description: "tutorial.roundingDescription",
    side: "right",
  },
  {
    id: "price-compare",
    page: "price-rules",
    element: '[data-tutorial="price-compare"]',
    title: "tutorial.compareAt",
    description: "tutorial.compareAtDescription",
    side: "right",
  },
  {
    id: "price-ranges",
    page: "price-rules",
    element: '[data-tutorial="price-ranges"]',
    title: "tutorial.priceRanges",
    description: "tutorial.priceRangesDescription",
    side: "right",
  },
  {
    id: "price-existing",
    page: "price-rules",
    element: '[data-tutorial="price-existing"]',
    title: "tutorial.existingRules",
    description: "tutorial.existingRulesDescription",
    side: "top",
  },

  // ═══════════════════════════════════════════
  // MAPEO DE CATEGORÍAS
  // ═══════════════════════════════════════════
  {
    id: "category-intro",
    page: "category-mapping",
    element: '[data-tutorial="category-page"]',
    title: "tutorial.categoryMappingTitle",
    description: "tutorial.categoryMappingDescription",
    side: "bottom",
    isPageIntro: true,
  },
  {
    id: "category-combobox",
    page: "category-mapping",
    element: '[data-tutorial="category-combobox"]',
    title: "tutorial.fileCategoriesDesc",
    description: "tutorial.fileCategoriesDescription",
    side: "right",
  },
  {
    id: "category-collections",
    page: "category-mapping",
    element: '[data-tutorial="category-collections"]',
    title: "tutorial.shopifyCollectionsDesc",
    description: "tutorial.shopifyCollectionsDescription",
    side: "left",
  },
  {
    id: "category-tags",
    page: "category-mapping",
    element: '[data-tutorial="category-tags"]',
    title: "tutorial.tagsPerCategory",
    description: "tutorial.tagsPerCategoryDescription",
    side: "right",
  },
  {
    id: "category-product-type",
    page: "category-mapping",
    element: '[data-tutorial="category-product-type"]',
    title: "tutorial.shopifyType",
    description: "tutorial.shopifyTypeDescription",
    side: "right",
  },

  // ═══════════════════════════════════════════
  // PREVIEW
  // ═══════════════════════════════════════════
  {
    id: "preview-intro",
    page: "preview",
    element: '[data-tutorial="preview-page"]',
    title: "tutorial.importPreviewTitle",
    description: "tutorial.importPreviewDescription",
    side: "bottom",
    isPageIntro: true,
  },
  {
    id: "preview-filters",
    page: "preview",
    element: '[data-tutorial="preview-filters"]',
    title: "tutorial.previewFilters",
    description: "tutorial.previewFiltersDescription",
    side: "bottom",
  },
  {
    id: "preview-stats",
    page: "preview",
    element: '[data-tutorial="preview-stats"]',
    title: "tutorial.previewStats",
    description: "tutorial.previewStatsDescription",
    side: "bottom",
  },
  {
    id: "preview-table",
    page: "preview",
    element: '[data-tutorial="preview-table"]',
    title: "tutorial.productTable",
    description: "tutorial.productTableDescription",
    side: "top",
  },
  {
    id: "preview-action-badges",
    page: "preview",
    element: '[data-tutorial="preview-action-badge"]',
    title: "tutorial.productActions",
    description: "tutorial.productActionsDescription",
    side: "left",
  },

  // ═══════════════════════════════════════════
  // IMPORTAR
  // ═══════════════════════════════════════════
  {
    id: "import-run-btn",
    page: "import",
    element: '[data-tutorial="import-run-btn"]',
    title: "tutorial.importButton",
    description: "tutorial.importButtonDescription",
    side: "bottom",
  },
  {
    id: "import-filters",
    page: "import",
    element: '[data-tutorial="import-filters"]',
    title: "tutorial.importFilters",
    description: "tutorial.importFiltersDescription",
    side: "bottom",
  },
  {
    id: "import-stats",
    page: "import",
    element: '[data-tutorial="import-stats"]',
    title: "tutorial.lastImportStats",
    description: "tutorial.lastImportStatsDescription",
    side: "bottom",
  },
  {
    id: "import-cron",
    page: "import",
    element: '[data-tutorial="import-cron"]',
    title: "tutorial.scheduledImport",
    description: "tutorial.scheduledImportDescription",
    side: "top",
  },
  {
    id: "import-actions",
    page: "import",
    element: '[data-tutorial="import-actions"]',
    title: "tutorial.quickActions",
    description: "tutorial.quickActionsDescription",
    side: "top",
  },
  {
    id: "import-logs-tab",
    page: "import",
    element: '.Polaris-Tabs__TabItem:last-child .Polaris-Tabs__Tab',
    title: "tutorial.historyTab",
    description: "tutorial.historyTabDescription",
    side: "bottom",
  },
  {
    id: "import-logs-table",
    page: "import",
    element: '[data-tutorial="import-history"]',
    title: "tutorial.historyTitle",
    description: "tutorial.historyDescription",
    side: "top",
  },

  // ═══════════════════════════════════════════
  // HISTORIAL
  // ═══════════════════════════════════════════
  {
    id: "logs-intro",
    page: "logs",
    element: '[data-tutorial="logs-page"]',
    title: "tutorial.historyTitle",
    description: "tutorial.historyFullDescription",
    side: "bottom",
    isPageIntro: true,
  },
  {
    id: "logs-table",
    page: "logs",
    element: '[data-tutorial="logs-table"]',
    title: "tutorial.historyTable",
    description: "tutorial.historyTableDescription",
    side: "top",
  },

  // ═══════════════════════════════════════════
  // CONFIGURACIÓN GENERAL
  // ═══════════════════════════════════════════
  {
    id: "settings-intro",
    page: "settings",
    element: '[data-tutorial="settings-page"]',
    title: "tutorial.stepSettings",
    description: "tutorial.settingsDescription",
    side: "bottom",
    isPageIntro: true,
  },
  {
    id: "settings-duplicate-policy",
    page: "settings",
    element: '[data-tutorial="settings-duplicate-policy"]',
    title: "tutorial.duplicatePolicyDesc",
    description: "tutorial.duplicatePolicyDescription",
    side: "right",
  },
  {
    id: "settings-priority",
    page: "settings",
    element: '[data-tutorial="settings-priority"]',
    title: "tutorial.supplierPriorityDesc",
    description: "tutorial.supplierPriorityDescription",
    side: "right",
  },

  // ═══════════════════════════════════════════
  // DUPLICADOS
  // ═══════════════════════════════════════════
  {
    id: "duplicates-intro",
    page: "duplicates",
    element: '[data-tutorial="duplicates-page"]',
    title: "tutorial.stepDuplicates",
    description: "tutorial.duplicatesDescription",
    side: "bottom",
    isPageIntro: true,
  },
  {
    id: "duplicates-table",
    page: "duplicates",
    element: '[data-tutorial="duplicates-table"]',
    title: "tutorial.duplicatesTable",
    description: "tutorial.duplicatesTableDescription",
    side: "top",
  },

  // ═══════════════════════════════════════════
  // COLA DE IMPORTACIONES
  // ═══════════════════════════════════════════
  {
    id: "queue-intro",
    page: "queue",
    element: '[data-tutorial="queue-page"]',
    title: "tutorial.stepQueue",
    description: "tutorial.queueDescription",
    side: "bottom",
    isPageIntro: true,
  },
  {
    id: "queue-active",
    page: "queue",
    element: '[data-tutorial="queue-active"]',
    title: "common.processing",
    description: "tutorial.runningImports",
    side: "bottom",
  },
  {
    id: "queue-recent",
    page: "queue",
    element: '[data-tutorial="queue-recent"]',
    title: "tutorial.recentImports",
    description: "tutorial.recentImportsDescription",
    side: "top",
  },
];

export function getPageSteps(pageId: string): TutorialStep[] {
  return TUTORIAL_STEPS.filter((s) => s.page === pageId);
}

export function getNextPage(currentPageId: string): (typeof TUTORIAL_PAGES)[number] | null {
  const idx = TUTORIAL_PAGES.findIndex((p) => p.id === currentPageId);
  if (idx < 0 || idx >= TUTORIAL_PAGES.length - 1) return null;
  return TUTORIAL_PAGES[idx + 1];
}

export function getPrevPage(currentPageId: string): (typeof TUTORIAL_PAGES)[number] | null {
  const idx = TUTORIAL_PAGES.findIndex((p) => p.id === currentPageId);
  if (idx <= 0) return null;
  return TUTORIAL_PAGES[idx - 1];
}
