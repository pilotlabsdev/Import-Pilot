import type { ProductRow } from "./csv-parser.server";
import type { PriceResult } from "./price-rules.server";

function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ProductSetInput {
  title?: string;
  descriptionHtml?: string;
  productType?: string;
  vendor?: string;
  tags?: string[];
  metafields?: Array<{
    namespace: string;
    key: string;
    value: string;
    type: string;
  }>;
  seo?: {
    title: string;
    description: string;
  };
  files?: Array<{
    originalSource: string;
    alt: string;
    contentType: string;
  }>;
  variants?: Array<{
    optionValues?: Array<{ optionName: string; name: string }>;
    sku?: string;
    price?: string;
    compareAtPrice?: string;
    barcode?: string;
    inventoryQuantities?: Array<{
      locationId: string;
      name: string;
      quantity: number;
    }>;
    inventoryPolicy?: string;
    inventoryItem?: {
      tracked?: boolean;
      cost?: string;
    };
  }>;
  collections?: string[];
  productOptions?: Array<{
    name: string;
    values: Array<{ name: string }>;
  }>;
}

interface ColumnMap {
  shopifyField: string;
  csvColumn: string | null;
  defaultValue: string | null;
}

export function getField(
  row: ProductRow,
  columnMaps: ColumnMap[],
  shopifyField: string
): string {
  const mapping = columnMaps.find((m) => m.shopifyField === shopifyField);
  if (!mapping || !mapping.csvColumn) return mapping?.defaultValue || "";
  return row[mapping.csvColumn] || mapping.defaultValue || "";
}

function getFieldNumber(
  row: ProductRow,
  columnMaps: ColumnMap[],
  shopifyField: string
): number {
  const val = getField(row, columnMaps, shopifyField);
  const num = parseFloat(val.replace(",", "."));
  return isNaN(num) ? 0 : num;
}

export interface BulkProductInput {
  title?: string;
  descriptionHtml?: string;
  productType?: string;
  vendor?: string;
  tags?: string[];
  metafields?: Array<{ namespace: string; key: string; value: string; type: string }>;
  seo?: { title: string; description: string };
  status?: string;
  files?: Array<{ originalSource: string; alt: string; contentType: string }>;
  variants?: Array<{
    id?: string;
    sku?: string;
    price?: string;
    compareAtPrice?: string;
    barcode?: string;
    inventoryPolicy?: string;
    weight?: number;
    weightUnit?: string;
  }>;
  collectionsToJoin?: string[];
}

export const UPDATE_OPTIONS = [
  "name",
  "description",
  "price",
  "stock",
  "images",
  "vendor",
  "productType",
  "tags",
  "metafields",
  "collections",
] as const;

export type UpdateOption = (typeof UPDATE_OPTIONS)[number];

export function parseUpdateOptions(raw?: string | null): Set<UpdateOption> {
  try {
    const arr: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return new Set(UPDATE_OPTIONS);
    const valid = new Set<string>(UPDATE_OPTIONS);
    return new Set(arr.filter((o): o is UpdateOption => typeof o === "string" && valid.has(o)));
  } catch {
    return new Set(UPDATE_OPTIONS);
  }
}

function buildProductBase(
  row: ProductRow,
  columnMaps: ColumnMap[],
  prices: PriceResult
): Omit<BulkProductInput, "variants"> {
  const name = getField(row, columnMaps, "title") || "Sin nombre";
  const description = getField(row, columnMaps, "description");
  const shortDescription = getField(row, columnMaps, "short_description");
  const category = getField(row, columnMaps, "category");
  const brand = getField(row, columnMaps, "brand");
  const sku = getField(row, columnMaps, "sku");
  const ean = getField(row, columnMaps, "ean");
  const tipoProducto = getField(row, columnMaps, "tipo_producto");
  const link = getField(row, columnMaps, "link");
  const costo = getField(row, columnMaps, "price");

  const tags: string[] = [];

  const metafields = [];
  if (sku) metafields.push({ namespace: "custom", key: "supplier_sku", value: sku, type: "single_line_text_field" });
  if (costo) metafields.push({ namespace: "custom", key: "costo", value: costo.replace(",", "."), type: "number_decimal" });
  if (shortDescription) metafields.push({ namespace: "global", key: "description_tag", value: stripHtml(shortDescription), type: "single_line_text_field" });

  if (tipoProducto) {
    metafields.push({ namespace: "custom", key: "tipo_producto", value: tipoProducto, type: "single_line_text_field" });
  }

  if (link) {
    metafields.push({ namespace: "custom", key: "supplier_url", value: link, type: "single_line_text_field" });
  }

  return {
    title: name,
    descriptionHtml: description,
    productType: category,
    vendor: brand,
    tags,
    metafields,
    seo: { title: name, description: shortDescription || name },
  };
}

export function mapCsvRowToBulkCreateInput(
  row: ProductRow,
  columnMaps: ColumnMap[],
  prices: PriceResult,
  collections: string[],
  productStatus: string,
  locationId?: string,
  defaultTags?: string,
  categoryTags?: string
): BulkProductInput {
  const base = buildProductBase(row, columnMaps, prices);
  const sku = getField(row, columnMaps, "sku");
  const ean = getField(row, columnMaps, "ean");

  const tags: string[] = [];
  if (defaultTags) {
    for (const t of defaultTags.split(",")) {
      const trimmed = t.trim();
      if (trimmed) tags.push(trimmed);
    }
  }
  if (categoryTags) {
    for (const t of categoryTags.split(",")) {
      const trimmed = t.trim();
      if (trimmed && !tags.includes(trimmed)) tags.push(trimmed);
    }
  }

  const images: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const img = getField(row, columnMaps, `image${i}`);
    if (img) images.push(img);
  }

  return {
    ...base,
    tags,
    status: productStatus,
    collectionsToJoin: collections,
  };
}

export function mapCsvRowToBulkUpdateInput(
  row: ProductRow,
  columnMaps: ColumnMap[],
  prices: PriceResult,
  collections: string[],
  variantId: string,
  updateOptions?: Set<UpdateOption>
): BulkProductInput {
  const opts = updateOptions ?? new Set<UpdateOption>(UPDATE_OPTIONS);
  const base = buildProductBase(row, columnMaps, prices);
  const ean = getField(row, columnMaps, "ean");

  const input: BulkProductInput = {};

  if (opts.has("name")) input.title = base.title;
  if (opts.has("description")) {
    input.descriptionHtml = base.descriptionHtml;
    input.seo = base.seo;
  }
  if (opts.has("productType")) input.productType = base.productType;
  if (opts.has("vendor")) input.vendor = base.vendor;
  if (opts.has("tags")) input.tags = base.tags;
  if (opts.has("metafields")) {
    input.metafields = base.metafields;
  } else {
    const costMeta = base.metafields?.filter((m) => m.key === "costo");
    if (costMeta?.length) input.metafields = costMeta;
  }

  if (opts.has("price")) {
    input.variants = [
      {
        id: variantId,
        price: String(prices.regularPrice),
        ...(prices.compareAtPrice ? { compareAtPrice: String(prices.compareAtPrice) } : {}),
        barcode: ean,
      },
    ];
  }

  if (opts.has("collections")) input.collectionsToJoin = collections;

  return input;
}

export function mapCsvRowToProductSet(
  row: ProductRow,
  columnMaps: ColumnMap[],
  prices: PriceResult,
  collections: string[],
  locationId: string,
  defaultTags?: string,
  categoryTags?: string,
  shopifyProductType?: string | null
): ProductSetInput {
  const name = getField(row, columnMaps, "title") || "Sin nombre";
  const description = getField(row, columnMaps, "description");
  const shortDescription = getField(row, columnMaps, "short_description");
  const category = getField(row, columnMaps, "category");
  const brand = getField(row, columnMaps, "brand");
  const sku = getField(row, columnMaps, "sku");
  const ean = getField(row, columnMaps, "ean");
  const tipoProducto = getField(row, columnMaps, "tipo_producto");
  const link = getField(row, columnMaps, "link");
  const costo = getField(row, columnMaps, "price");
  const quantity = getFieldNumber(row, columnMaps, "quantity");

  const images: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const img = getField(row, columnMaps, `image${i}`);
    if (img) images.push(img);
  }

  const tags: string[] = [];
  if (defaultTags) {
    for (const t of defaultTags.split(",")) {
      const trimmed = t.trim();
      if (trimmed) tags.push(trimmed);
    }
  }
  if (categoryTags) {
    for (const t of categoryTags.split(",")) {
      const trimmed = t.trim();
      if (trimmed && !tags.includes(trimmed)) tags.push(trimmed);
    }
  }

  const metafields = [];
  if (sku) metafields.push({ namespace: "custom", key: "supplier_sku", value: sku, type: "single_line_text_field" });
  if (costo) metafields.push({ namespace: "custom", key: "costo", value: costo.replace(",", "."), type: "number_decimal" });
  if (shortDescription) metafields.push({ namespace: "global", key: "description_tag", value: stripHtml(shortDescription), type: "single_line_text_field" });

  if (tipoProducto) {
    metafields.push({ namespace: "custom", key: "tipo_producto", value: tipoProducto, type: "single_line_text_field" });
  }

  if (link) {
    metafields.push({ namespace: "custom", key: "supplier_url", value: link, type: "single_line_text_field" });
  }

  const stockQty = quantity;
  const costNum = costo ? parseFloat(costo.replace(",", ".")) : 0;

  return {
    title: name,
    descriptionHtml: description,
    productType: shopifyProductType || category,
    vendor: brand,
    tags,
    metafields,
    seo: {
      title: name,
      description: stripHtml(shortDescription) || name,
    },
    files: images.map((url) => ({
      originalSource: url,
      alt: name,
      contentType: "IMAGE",
    })),
    variants: [
      {
        optionValues: [],
        sku: sku || undefined,
        price: String(prices.regularPrice),
        ...(prices.compareAtPrice
          ? { compareAtPrice: String(prices.compareAtPrice) }
          : {}),
        barcode: ean,
        inventoryQuantities: [
          {
            locationId,
            name: "available",
            quantity: stockQty,
          },
        ],
        inventoryPolicy: "DENY",
        inventoryItem: {
          tracked: true,
          ...(costNum > 0 ? { cost: String(costNum) } : {}),
        },
      },
    ],
    collections,
  };
}

export function mapCsvRowToProductSetUpdate(
  row: ProductRow,
  columnMaps: ColumnMap[],
  prices: PriceResult,
  collections: string[],
  locationId: string,
  updateOptions?: Set<UpdateOption>
): ProductSetInput {
  const opts = updateOptions ?? new Set<UpdateOption>(UPDATE_OPTIONS);
  const name = getField(row, columnMaps, "title") || "Sin nombre";
  const description = getField(row, columnMaps, "description");
  const shortDescription = getField(row, columnMaps, "short_description");
  const category = getField(row, columnMaps, "category");
  const brand = getField(row, columnMaps, "brand");
  const sku = getField(row, columnMaps, "sku");
  const ean = getField(row, columnMaps, "ean");
  const tipoProducto = getField(row, columnMaps, "tipo_producto");
  const link = getField(row, columnMaps, "link");
  const costo = getField(row, columnMaps, "price");
  const quantity = getFieldNumber(row, columnMaps, "quantity");
  const stockQty = quantity;
  const costNum = costo ? parseFloat(costo.replace(",", ".")) : 0;

  const input: ProductSetInput = {
    title: name,
    descriptionHtml: description,
    productType: category,
    vendor: brand,
    tags: [],
    metafields: [],
    seo: { title: name, description: stripHtml(shortDescription) || name },
    files: [],
    variants: [],
    collections: [],
  };

  if (!opts.has("name")) delete input.title;
  if (!opts.has("description")) { delete input.descriptionHtml; delete input.seo; }
  if (!opts.has("productType")) delete input.productType;
  if (!opts.has("vendor")) delete input.vendor;
  if (!opts.has("tags")) delete input.tags;
  if (!opts.has("metafields")) {
    input.metafields = [];
  } else {
    const metafields = [];
    if (sku) metafields.push({ namespace: "custom", key: "supplier_sku", value: sku, type: "single_line_text_field" });
    if (costo) metafields.push({ namespace: "custom", key: "costo", value: costo.replace(",", "."), type: "number_decimal" });
    if (shortDescription) metafields.push({ namespace: "global", key: "description_tag", value: stripHtml(shortDescription), type: "single_line_text_field" });
    if (tipoProducto) metafields.push({ namespace: "custom", key: "tipo_producto", value: tipoProducto, type: "single_line_text_field" });
    if (link) metafields.push({ namespace: "custom", key: "supplier_url", value: link, type: "single_line_text_field" });
    input.metafields = metafields;
  }

  if (!opts.has("collections")) delete input.collections;

  const variant: any = {
    optionValues: [{ optionName: "Title", name: "Default Title" }],
    sku: sku || undefined,
    barcode: ean,
    inventoryQuantities: [],
    inventoryPolicy: "DENY",
  };

  if (opts.has("price")) {
    variant.price = String(prices.regularPrice);
    if (prices.compareAtPrice) variant.compareAtPrice = String(prices.compareAtPrice);
  }

  if (opts.has("stock")) {
    variant.inventoryQuantities = [{ locationId, name: "available", quantity: stockQty }];
  }

  if (costNum > 0) {
    variant.inventoryItem = { tracked: true, cost: String(costNum) };
  }

  input.variants = [variant];

  if (opts.has("collections")) {
    input.collections = collections;
  }

  input.productOptions = [{ name: "Title", values: [{ name: "Default Title" }] }];

  delete input.files;

  return input;
}
