import { useEffect } from "react";
import { useLocation } from "react-router";
import { buildAdminAppUrl, shopFromCookieHeader } from "~/lib/admin-link";

/**
 * Delivers Shopify's App Bridge "bounce" HTML (thrown by authenticate.admin when the
 * embedded session is lost) back to the browser instead of intercepting it in the
 * ErrorBoundary.
 *
 * - With shop/host params: the bounce script runs, patches the session token and
 *   reloads the original URL (shopify-reload) — Shopify's designed self-healing.
 * - Without params: the server normally 302s top-level requests to the Shopify
 *   admin before this ever renders (see /app loader). Only iframe/embedded
 *   requests reach this point, where the official HTML recovers the context from
 *   the parent admin frame. As a last resort (top-level, e.g. a browser without
 *   Sec-Fetch-Dest), navigate once to a deterministic admin URL — never to
 *   document.referrer, which ping-pongs into a bare-URL loop.
 */
export function AppBridgeBounce({ html }: { html: string }) {
  const location = useLocation();
  const hasShop = new URLSearchParams(location.search).has("shop");

  useEffect(() => {
    if (hasShop) {
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
      return;
    }

    // Sin shop: si estamos embebidos, el HTML oficial (renderizado abajo) ya se
    // encarga de recuperar el contexto del padre — no hacer nada aquí.
    let embedded = true;
    try {
      embedded = window.top !== window.self;
    } catch {
      embedded = true;
    }
    if (embedded) return;

    // Top-level (caso borde): destino único determinístico, sin referrer.
    window.location.replace(buildAdminAppUrl(shopFromCookieHeader(document.cookie)));
  }, [html, hasShop]);

  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
