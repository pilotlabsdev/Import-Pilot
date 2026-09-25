import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Delivers Shopify's App Bridge "bounce" HTML (thrown by authenticate.admin when the
 * embedded session is lost) back to the browser instead of intercepting it in the
 * ErrorBoundary — intercepting it and redirecting to a param-less URL caused an
 * infinite "Cargando..." loop.
 *
 * - With shop/host params: the bounce script runs, patches the session token and
 *   reloads the original URL (shopify-reload) — Shopify's designed self-healing.
 * - Without params (e.g. bare /app): reload the parent admin page so it regenerates
 *   a fresh embedded URL with valid auth params.
 */
export function AppBridgeBounce({ html }: { html: string }) {
  const location = useLocation();
  const hasShop = new URLSearchParams(location.search).has("shop");

  useEffect(() => {
    if (!hasShop) {
      const target = document.referrer || "https://admin.shopify.com";
      if (window.top && window.top !== window.self) {
        try {
          window.top.location.replace(target);
          return;
        } catch {}
      }
      window.location.replace(target);
      return;
    }
    // SSR: scripts already executed when the document was parsed.
    // Client-side boundary renders don't execute innerHTML scripts — recreate them.
    if (document.querySelector("script[data-api-key]")) return;
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("script").forEach((old) => {
        const s = document.createElement("script");
        for (const attr of Array.from(old.attributes)) s.setAttribute(attr.name, attr.value);
        if (!old.src && old.textContent) s.textContent = old.textContent;
        document.head.appendChild(s);
      });
    } catch {}
  }, [html, hasShop]);

  if (!hasShop) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
        <p style={{ fontSize: "14px", color: "#6d7175" }}>Recuperando sesión...</p>
      </div>
    );
  }

  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
