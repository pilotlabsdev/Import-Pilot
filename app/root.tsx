import type { LoaderFunctionArgs } from "react-router";
import { data, Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useRouteError, isRouteErrorResponse } from "react-router";
import { Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import esPolaris from "@shopify/polaris/locales/es.json";
import enPolaris from "@shopify/polaris/locales/en.json";
import ptPolaris from "@shopify/polaris/locales/pt-BR.json";
import frPolaris from "@shopify/polaris/locales/fr.json";
import dePolaris from "@shopify/polaris/locales/de.json";
import itPolaris from "@shopify/polaris/locales/it.json";

const polarisTranslations: Record<string, any> = {
  es: esPolaris, en: enPolaris, pt: ptPolaris, fr: frPolaris, de: dePolaris, it: itPolaris,
};

const langMap: Record<string, string> = {
  es: "es", en: "en", pt: "pt-BR", fr: "fr", de: "de", it: "it",
};

const SUPPORTED = ["es", "en", "pt", "fr", "de", "it"];

function normalizeLocale(raw: string | undefined | null): string {
  if (!raw) return "en";
  const base = raw.split("-")[0].toLowerCase();
  if (SUPPORTED.includes(base)) return base;
  return "en";
}

function detectLocale(shopifyLocale: string | null, cookieLocale: string | null): string {
  if (shopifyLocale) {
    const map: Record<string, string> = {
      es: "es", "es-ES": "es", en: "en", "en-US": "en", "en-GB": "en",
      pt: "pt", "pt-BR": "pt", fr: "fr", de: "de", it: "it",
    };
    if (map[shopifyLocale]) return map[shopifyLocale];
    const base = shopifyLocale.split("-")[0];
    if (SUPPORTED.includes(base)) return base;
  }
  if (cookieLocale && SUPPORTED.includes(cookieLocale)) return cookieLocale;
  return "en";
}

export const loader = ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopifyLocale = url.searchParams.get("locale");
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookieLocale = cookieHeader.match(/(?:^|;\s*)shop_locale=([^;]*)/)?.[1] || null;
  const locale = detectLocale(shopifyLocale, cookieLocale);

  return data(
    { locale, apiKey: process.env.SHOPIFY_API_KEY || "" },
    {
      headers: shopifyLocale
        ? { "Set-Cookie": `shop_locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax` }
        : undefined,
    }
  );
};

const SHOPIFY_API_KEY = import.meta.env.VITE_SHOPIFY_API_KEY || "";

export function Layout({ children }: { children: React.ReactNode }) {
  const { i18n } = useTranslation();

  return (
    <html lang={langMap[i18n.language] || "en"}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="shopify-api-key" content={SHOPIFY_API_KEY} />
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link rel="stylesheet" href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css" />
        <Meta />
        <Links />
        <style>{`.app-tutorial-highlight{outline:3px solid #006fbb !important;outline-offset:2px !important;border-radius:4px !important;position:relative;z-index:100000 !important}`}</style>
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { locale: serverLocale } = useLoaderData<typeof loader>();
  const { i18n } = useTranslation();
  const [clientLocale, setClientLocale] = useState<string | null>(null);

  useEffect(() => {
    try {
      const shopify = (window as any).shopify;
      if (shopify?.config?.locale) {
        const normalized = normalizeLocale(shopify.config.locale);
        setClientLocale(normalized);
        return;
      }
    } catch {}

    try {
      const match = document.cookie.match(/(?:^|;\s*)shop_locale=([^;]*)/);
      const val = match?.[1];
      if (val && SUPPORTED.includes(val)) {
        setClientLocale(val);
        return;
      }
    } catch {}
  }, []);

  useEffect(() => {
    const bestLocale = clientLocale || serverLocale || "en";
    if (SUPPORTED.includes(bestLocale) && i18n.language !== bestLocale) {
      i18n.changeLanguage(bestLocale);
    }
  }, [clientLocale, serverLocale, i18n]);

  const effectiveLocale = clientLocale || serverLocale || "en";

  return (
    <PolarisAppProvider i18n={polarisTranslations[effectiveLocale] || enPolaris}>
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </PolarisAppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 0;
  const isAuth = status === 401;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Import Pilot</title>
      </head>
      <body style={{ fontFamily: "Inter, sans-serif", display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", margin: 0, background: "#f6f6f7" }}>
        <div style={{ textAlign: "center", padding: "40px", background: "white", borderRadius: "8px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)", maxWidth: "400px" }}>
          {isAuth ? (
            <>
              <h2 style={{ marginBottom: "12px" }}>Sesión expirada</h2>
              <p style={{ color: "#6d7175", marginBottom: "20px" }}>Reconectando...</p>
            </>
          ) : (
            <>
              <h2 style={{ marginBottom: "12px" }}>Algo salió mal</h2>
              <p style={{ color: "#6d7175", marginBottom: "20px" }}>Error del servidor. Intenta de nuevo.</p>
            </>
          )}
          {isAuth ? (
            <style>{`setTimeout(() => window.location.reload(), 2000)`}</style>
          ) : (
            <button
              onClick={() => window.location.reload()}
              style={{ padding: "8px 20px", borderRadius: "4px", border: "none", background: "#006fbb", color: "white", cursor: "pointer", fontSize: "14px" }}
            >
              Reconectar
            </button>
          )}
        </div>
        <Scripts />
      </body>
    </html>
  );
}
