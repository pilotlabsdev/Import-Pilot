# Import Pilot — Setup Instructions for Reviewers

These instructions walk you through the complete workflow of the app using the sample CSV provided at:

**Sample CSV (direct link):** https://import-pilot-production.up.railway.app/sample-feed.csv

The sample file is a standard comma-separated CSV with 5 demo products. You can either paste the URL above into the app, or download the file and upload it from your computer (the app supports both).

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
6. Leave the other options at their defaults (import mode: Chunks, product status: Draft, frequency: any) and click **Save**.

## 4. Map columns

1. Open the **Columns** tab. The app reads the CSV header and lists its columns: `sku, ean, name, description, category, quantity, price, brand, product_type, image1`.
2. For each column, choose the matching Shopify field in the dropdown (SKU → SKU, ean → EAN/barcode, name → Title, price → Price, quantity → Quantity, brand → Vendor, etc.).
3. The default mappings already match this sample, so you only need to confirm and save.

## 5. Preview (optional but recommended)

1. Open the **Preview** tab. The app shows what will be created: 5 products with titles, prices, stock and images.
2. Use the filters (by SKU, by category) if you want to import a subset.

## 6. Run the import

1. Go to the **Import** tab.
2. Click **Run import**.
3. Progress appears live (products processed / total). When it finishes, the stats show: created, updated, unchanged, excluded.
4. Open your Shopify **Products** admin: the 5 demo products are there with images, prices and stock.

## 7. Verify updates

1. Edit one product in Shopify (change its price or title).
2. Run the import again from the **Import** tab.
3. The change is restored from the CSV — the app treats the file as the source of truth for the fields you enable in Configuration → Update fields.

## 8. History & Queue

- **History** tab: log of every import with date, status and counters (created/updated/unchanged/excluded/errors).
- **Queue** (left navigation): shows running and scheduled imports; you can cancel an active one.

## 9. Scheduled imports (cron)

In the **Import** tab, the **Scheduled import** card has a start/stop button. Activating it re-imports automatically at the chosen frequency (e.g. every 6 hours). A data source (URL or file) is required before the cron can be activated.

---

### Notes for reviewers

- Products are created as **Draft** by default so you can review them before publishing (configurable per supplier).
- The app never deletes products and never changes their status on updates.
- Prices support formulas, rounding rules (e.g. `.95`, `.99`) and compare-at prices — see the **Price rules** tab.
- Categories in the CSV can be mapped to Shopify collections — see the **Categories** tab.
- Duplicate detection across multiple suppliers is configurable in **Settings**.
- The app supports CSV and Excel (`.xlsx`) files.
