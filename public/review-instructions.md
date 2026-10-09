# Import Pilot — Setup Instructions for Reviewers

These instructions walk you through the complete workflow of the app using the sample CSV provided at:

**Sample CSV (direct link):** https://import-pilot-production.up.railway.app/sample-feed.csv

The sample file is a standard comma-separated CSV with 5 demo products. You can either paste the URL above into the app, or download the file and upload it from your computer (the app supports both). Product images are hosted on our domain and imported automatically.

CSV columns: `sku, ean, name, short_description, description, category, quantity, price, brand, product_type, weight, image1, image2, image3`

Each product includes 3 images (the app supports up to 5 per product).

---

## 1. Open the app

From your Shopify admin, go to **Apps → Import Pilot**. The dashboard shows your suppliers and a **"New supplier"** button.

## 2. Create a supplier

1. Click **New supplier** and give it a name (e.g. "Review Test").
2. The supplier is created and you land on its detail page with several tabs: **Import, Configuration, Columns, Price rules, Categories, Preview, History**.

## 3. Configure the data source

1. Open the **Configuration** tab.
2. Under **Data source**, keep **URL** selected.
3. Paste the sample CSV URL: `https://import-pilot-production.up.railway.app/sample-feed.csv`
4. *(Alternative)* If you prefer a local file: switch to **File**, click the drop zone and select the downloaded `sample-feed.csv`.
5. The delimiter is auto-detected (the sample uses commas), so you can leave it on **Auto**.
6. Click **Save**.

## 4. Map columns

1. Open the **Columns** tab. The app reads the CSV header and lists its columns.
2. For each column, choose the matching Shopify field in the dropdown:
   - `sku` → **SKU**, `ean` → **EAN/barcode**, `name` → **Title**, `short_description` → **Short description (SEO)**, `description` → **Description (HTML)**, `category` → **Category**, `quantity` → **Quantity**, `price` → **Price**, `brand` → **Brand/Vendor**, `product_type` → **Product type**, `weight` → **Weight**, `image1` → **Image 1**, `image2` → **Image 2**, `image3` → **Image 3**.
3. The default mappings already match this sample, so you only need to confirm and save.

## 5. Configure which fields update existing products

In **Configuration → Fields to update on existing products**, choose what re-imports may change on products that already exist: name, description, price, stock, images, vendor, product type, tags, collections. Unselected fields are preserved as-is in Shopify.

Related options in the same tab:

- **Default tags**: comma-separated tags added to all imported products (e.g. `Imported, Sale`).
- **Product status (on create)**: products are created as **Draft** by default so you can review them before publishing.
- **Don't create products with zero stock**: skips creation when quantity is 0.
- **Import mode**: *Chunks* (synchronous, live progress) or *Bulk* (async Shopify bulk operations, better for very large files).

## 6. Price rules

The **Price rules** tab lets you transform supplier prices before importing. Three levels with priority: **By product SKU** > **By category** > **General Rule**.

Each rule supports:

- **Price formula**: arithmetic expression using the supplier price (supports `C`, numbers, `+ - * / ( )`, decimal comma). Example: `C * 1.21` (add 21% VAT).
- **Rounding**: round to `.95`, `.99`, to a fixed number of decimals, or a custom value.
- **Compare-at price** (optional): set the "compare at" price based on a formula, fixed value or percentage — useful for showing discounts.

Example: General Rule with formula `C * 1.21` and rounding `.95` turns a supplier price of 12.34 into 14.95.

## 7. Category mapping

The **Categories** tab maps categories from the CSV to Shopify collections:

1. Select a file category (read from the CSV `category` column).
2. Select one or more Shopify collections for it.
3. Optionally add **tags for this category** (comma-separated, added to products in that category) and a **Shopify type** (product type override).
4. Save the mapping. Repeat for each category.

Unmapped categories are imported without collection assignment.

## 8. Exclusions (skip rules)

In **Configuration → Exclusions**, define products to skip during import (create and update):

- **Exclude by title words**: comma-separated words found in the product title (e.g. `outlet, refurbished, B-stock`).
- **Exclude by SKU**: comma-separated patterns, supports `*` at start/end (e.g. `OUT-*, *-END, TEST-SKU`).
- **Exclude by EAN**: exact EANs or wildcards (e.g. `8412345*, *0001`).
- **Exclude by brand**: pick brands to skip.
- **SKU/EAN exclusions (specific fields)**: for specific SKUs/EANs, skip only the price, only the stock, or both while still updating the rest (e.g. a product whose price must never be touched).

Excluded products are counted in the "Excluded" stat of each import.

## 9. Preview (optional but recommended)

1. Open the **Preview** tab. The app shows what will be created: 5 products with titles, prices, stock, weight, SEO description and images.
2. Use the filters (by SKU, by category) if you want to import a subset.

## 10. Run the import

1. Go to the **Import** tab.
2. Click **Run import**.
3. Progress appears live (products processed / total). When it finishes, the stats show: created, updated, unchanged, excluded.
4. Open your Shopify **Products** admin: the 5 demo products are there with images, prices, stock, weight and SEO descriptions.

## 11. Verify updates

1. Edit one product in Shopify (change its price or title).
2. Run the import again from the **Import** tab.
3. The change is restored from the CSV — the app treats the file as the source of truth for the fields you enabled in step 5.

## 12. History & Queue

- **History** tab: log of every import with date, status and counters (created/updated/unchanged/excluded/errors).
- **Queue** (left navigation): shows running and scheduled imports; you can cancel an active one.

## 13. Scheduled imports (cron)

In the **Import** tab, the **Scheduled import** card has a start/stop button and a **Frequency** selector (30 min to weekly). Activating it re-imports automatically at the chosen frequency. A data source (URL or file) is required before the cron can be activated.

## 14. Multiple suppliers: duplicates & priority (Settings)

When more than one supplier imports products with overlapping EANs, configure behavior in **Settings** (left navigation):

- **Duplicate Policy** — what happens when two suppliers import the same EAN with different SKUs:
  - *Create both*: allows duplicates.
  - *Prioritize supplier*: the supplier with higher priority wins; the other is ignored.
  - *Skip if already exists*: products already in Shopify are not created or updated.
- **Supplier Priority**: drag suppliers into priority order (first = highest).
- **Match mode** — when EAN matches but SKU is different: *update + keep the existing SKU* or *update + replace the SKU with the file's*.
- **Include products created outside the app**: apply priority rules to products that were not imported by this app.

---

### Notes for reviewers

- The app never deletes products and never changes their status on updates.
- Products are created as **Draft** by default (configurable per supplier).
- The app supports CSV and Excel (`.xlsx`) files, with files uploaded from your computer or fetched from a URL (including Google Drive/Sheets).
- Inventory location can be selected per supplier in Configuration (a location named like your store's default is auto-detected).
