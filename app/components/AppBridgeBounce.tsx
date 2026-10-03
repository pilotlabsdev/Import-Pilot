import { useEffect } from "react";
import { useLocation } from "react-router";
import { buildAdminAppUrl, shopFromCookieHeader, readStoredShop, CTX_RETRY_KEY } from "~/lib/admin-link";

/**
 * Delivers Shopify's App Bridge "bounce" HTML (thrown by authenticate.admin when the
 * embedded session is lost) back to the browser instead of intercepting it in the
 * ErrorBoundary.
 *
 * - With shop/host params: the bounce script runs, patches the session token and
 *   reloads the original URL (shopify-reload) — Shopify's designed self-healing.
 * - Without params: the /app loader bounces top-level requests to the Shopify
 *   admin with an inline script (never a 302 — followed inside the iframe it
 *   would hit X-Frame-Options deny).
 *   Only iframe/embedded requests reach this point, and the official HTML alone
 *   does NOT recover (verified in production → blank page): App Bridge has no
 *   shop context. Instead we navigate the top window back to the admin with the
 *   same route (shop from sessionStorage, saved by app.tsx while the URL had it)
 *   so Shopify re-embeds the app with fresh params. Top-level (no
 *   Sec-Fetch-Dest) does the same once with a deterministic admin URL — never
 *   to document.referrer, which ping-pongs into a bare-URL loop.
 */
export function AppBridgeBounce({ html }: { html: string }) {
  const location = useLocation();
  const hasShop = new URLSearchParams(location.search).has("shop");

  useEffect(() => {
    if (hasShop) {
      // SSR: scripts already executed when the document was parsed.
      // Client-side boundary renders don't execute innerHTML scripts — recreate them.
      if (document.querySelector("script[data-api-key], script[data-plans-gate]")) return;
      try {
        const doc = new DOMParser().parseFromString(html, "text/html");
        doc.querySelectorAll("script").forEach((old) => {
          const s = document.createElement("script");
          for (const attr of Array.from(old.attributes)) s.setAttribute(attr.name, attr.value);
          if (!old.src && old.textContent) s.textContent = old.textContent;
          document.head.appendChild(s);
        });
      } catch {}
      return;
    }

    // Sin shop: el HTML oficial NO se recupera solo (App Bridge no sabe de qué
    // tienda recargar nada → quedaba en blanco). Navegar la ventana top al
    // admin con la ruta actual para que Shopify re-embea con params frescos.
    let embedded = true;
    try {
      embedded = window.top !== window.self;
    } catch {
      embedded = true;
    }
    if (embedded) {
      const shop = readStoredShop() || shopFromCookieHeader(document.cookie);
      // Cooldown anti-bucle: un solo intento cada 15s por pestaña.
      try {
        const last = Number(sessionStorage.getItem(CTX_RETRY_KEY) || "0");
        if (Date.now() - last < 15_000) return;
        sessionStorage.setItem(CTX_RETRY_KEY, String(Date.now()));
      } catch {}
      const target = buildAdminAppUrl(shop, `${location.pathname}${location.search}`);
      console.log(`[AppBridgeBounce] URL sin shop en iframe → recuperando vía admin (${shop || "universal"}): ${target}`);
      const top = window.top;
      if (top) {
        try {
          top.location.replace(target);
        } catch {
          top.location.href = target;
        }
      }
      return;
    }

    // Top-level (caso borde): destino único determinístico — la misma página en
    // el admin, sin referrer.
    window.location.replace(
      buildAdminAppUrl(shopFromCookieHeader(document.cookie), `${location.pathname}${location.search}`)
    );
  }, [html, hasShop, location.pathname, location.search]);

  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
