import type { MetaFunction } from "react-router";

export const meta: MetaFunction = () => [
  { title: "Privacy Policy - Import Pilot" },
];

export default function PrivacyPolicy() {
  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "2rem", fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
      <h1>Privacy Policy</h1>
      <p><em>Last updated: September 1, 2026</em></p>

      <h2>1. Introduction</h2>
      <p>
        Import Pilot ("we", "our", or "us") operates as a Shopify application that helps merchants import and manage product catalogs from supplier CSV/Excel files. This Privacy Policy explains how we collect, use, and protect information when you use our application.
      </p>

      <h2>2. Information We Collect</h2>
      <p><strong>Shop Data:</strong> When you install Import Pilot, we access your Shopify store data necessary for product import operations, including:</p>
      <ul>
        <li>Product information (titles, descriptions, prices, images, variants)</li>
        <li>Inventory data and locations</li>
        <li>Collections and product categories</li>
        <li>Metafields for custom product data</li>
      </ul>

      <p><strong>Configuration Data:</strong> We store import configurations, price rules, column mappings, category mappings, and import logs within your Shopify database instance.</p>

      <p><strong>No Personal Customer Data:</strong> We do not collect, store, or process your customers' personal information (names, emails, addresses, payment details). Our app operates solely on product and catalog data.</p>

      <h2>3. How We Use Information</h2>
      <ul>
        <li>To import and update products from your suppliers into your Shopify store</li>
        <li>To apply price rules and transformations you configure</li>
        <li>To map supplier categories to your Shopify collections</li>
        <li>To track import history and detect duplicates</li>
        <li>To provide scheduled automated imports</li>
      </ul>

      <h2>4. Data Storage</h2>
      <p>
        All data is stored within your Shopify instance using Shopify's built-in database. We do not transfer your data to external servers except for fetching supplier CSV/Excel files from URLs you explicitly configure.
      </p>

      <h2>5. Data Sharing</h2>
      <p>
        We do not share, sell, or distribute your data to third parties. The only external communication is with supplier file URLs that you configure for product catalog imports.
      </p>

      <h2>6. Data Retention</h2>
      <p>
        Your data is retained as long as you have the app installed. Import logs and job history are automatically cleaned up after a configurable period (default: 30 days). When you uninstall the app, all associated data is removed through Shopify's standard app uninstallation process.
      </p>

      <h2>7. Security</h2>
      <p>
        We use Shopify's built-in authentication and authorization mechanisms (OAuth 2.0, session tokens). All API communications are encrypted via HTTPS. We follow Shopify's security best practices for embedded applications.
      </p>

      <h2>8. Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. Changes will be reflected at the top of this page with an updated date.
      </p>

      <h2>9. Contact</h2>
      <p>
        If you have questions about this Privacy Policy, please contact us through the support feature within the Import Pilot app, or email us at pilotlabsdev@gmail.com.
      </p>
    </div>
  );
}
