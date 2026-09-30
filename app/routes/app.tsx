import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, redirect, Outlet, useLoaderData, useRouteError, isRouteErrorResponse, useLocation, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { useTranslation } from "react-i18next";
import { useState, useEffect } from "react";
import { useRevalidator } from "react-router";

import { safeAuthenticate, isDeveloperStore } from "~/shopify.server";
import { prisma } from "~/lib/db.server";
import { TutorialProvider, stopTutorial } from "~/components/TutorialProvider";
import { CrispChat } from "~/components/CrispChat";
import { getSubscriptionInfo, type SubscriptionInfo } from "~/lib/billing.server";
import { ReconnectingOverlay, triggerReconnect } from "~/components/ReconnectingOverlay";
import { AppBridgeBounce } from "~/components/AppBridgeBounce";
import { ADMIN_ORIGIN, SHOP_COOKIE, buildAdminAppUrl, buildPlansUrl, shopFromCookieHeader, CTX_KEY } from "~/lib/admin-link";
import { getNavCounts } from "~/lib/nav-counts.server";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[App Loader] Timeout ${label}: ${ms}ms`)), ms)
    ),
  ]);
}

function handleNavClick(e: React.MouseEvent<HTMLAnchorElement>) {
  stopTutorial();
}

// --- Restauración de ruta tras rebote de auth (solo pestaña inactiva) ---
// safeAuthenticate redirige a "/" cuando el token caduca; eso desmonta y
// remonta el layout App (las únicas rutas fuera de /app son raíz), y el
// usuario aterriza en /app (dashboard). Guardamos la última ruta de este
// documento y la restauramos SOLO si App remonta dentro del mismo documento
// (rebote). Cargas de documento nuevas (abrir desde admin, F5, NavMenu que
// usa <a>) resetean los flags → nunca restauran.
const LAST_ROUTE_KEY = "ip_last_route";
const VOLATILE_PARAMS = ["shop", "host", "id_token", "session_token", "hmac", "timestamp", "locale", "embedded", "session", "billing_id"];
const RESTORE_COOLDOWN_MS = 30_000;
let docLoaded = false;
let lastRestoreAt = 0;

function stripVolatileParams(search: string): string {
  if (!search) return "";
  const params = new URLSearchParams(search);
  for (const key of VOLATILE_PARAMS) params.delete(key);
  const out = params.toString();
  return out ? `?${out}` : "";
}

function ClientOnly({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <nav style={{ height: "44px" }} />;
  return <>{children}</>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const tl0 = Date.now();
  const url = new URL(request.url);

  // URL sin parámetros `shop` (deep-link borrado, pestaña restaurada, etc.).
  // SOLO se redirige un documento top-level de verdad — las peticiones .data de
  // navegación SPA tampoco llevan `shop` (los params viven en el documento
  // actual, no en el destino del link) y redirigirlas a admin hacía que el
  // router navegase el iframe a admin.shopify.com → X-Frame-Options deny.
  // - dest=document / mode=navigate top-level → 302 server-side al admin
  // - dest=iframe o Referer=admin → bounce oficial de App Bridge
  // - .data / prefetch (dest=empty, mode=cors) → authenticate normal (token)
  if (!url.searchParams.get("shop")) {
    const dest = (request.headers.get("Sec-Fetch-Dest") || "").toLowerCase();
    const mode = (request.headers.get("Sec-Fetch-Mode") || "").toLowerCase();
    const accept = request.headers.get("Accept") || "";
    const referer = request.headers.get("Referer") || "";
    const embedded = dest === "iframe" || referer.startsWith(ADMIN_ORIGIN);
    const isTopLevelDocument = !embedded && (
      dest === "document" ||
      mode === "navigate" ||
      (dest === "" && mode === "" && accept.includes("text/html"))
    );
    if (isTopLevelDocument) {
      let shop = shopFromCookieHeader(request.headers.get("Cookie"));
      let source = shop ? "cookie" : null;
      if (!shop) {
        try {
          const rows = await prisma.session.findMany({ select: { shop: true }, distinct: ["shop"] });
          if (rows.length === 1) { shop = rows[0].shop; source = "db-unico"; }
        } catch {}
      }
      const target = buildAdminAppUrl(shop, `${url.pathname}${url.search}`);
      const refHost = (() => { try { return referer ? new URL(referer).host + new URL(referer).pathname : "-"; } catch { return "-"; } })();
      console.error(`[App Loader] URL sin shop en ${url.pathname} → 302 a ${target} (fuente: ${source || "universal"}, dest=${dest || "-"}, mode=${mode || "-"}, referer=${refHost})`);
      return redirect(target);
    }
  }

  // Retorno del welcome link de Shopify App Pricing: llega como documento
  // top-level con plan_handle+shop pero SIN `host` — authenticate.admin lo
  // rechazaría en validateShopAndHostParams y perderíamos la verificación del
  // plan. Datos benignos aquí; el loader de app/billing verifica el contrato
  // con la Partner API y redirige a /app/billing limpio.
  if (url.searchParams.get("plan_handle")) {
    return data({
      apiKey: process.env.SHOPIFY_API_KEY || "",
      shopDomain: url.searchParams.get("shop") || "",
      unresolvedCount: 0,
      queueCount: 0,
      planLabel: null,
      hasPlan: true,
    });
  }

  // Gate a planes lo antes posible: getSubscriptionInfo se lanza EN PARALELO
  // con safeAuthenticate usando el shop de la URL (authenticate valida después
  // que el id_token pertenece a esa tienda; si no cuadra, auth falla y el
  // resultado especulativo se descarta). Partner API cachea 5min/15s.
  // PERF: antes el loader hacía getSubscriptionInfo DOS veces por navegación
  // (gate vía requireSubscription + counts) ≈6 queries extra a la BD; ahora se
  // hace UNA y se reutiliza para hasPlan + planLabel + counts.
  const isBillingPage = url.pathname === "/app/billing";
  const isTutorialPage = url.pathname.startsWith("/app/tutorial");
  const needsPlanGate = !isBillingPage && !isTutorialPage;
  const shopParam = (url.searchParams.get("shop") || "").toLowerCase();
  const looksLikeRealDoc =
    (url.searchParams.get("embedded") === "1" ||
      url.searchParams.has("id_token") ||
      url.searchParams.has("session_token")) &&
    /^[a-z0-9][a-z0-9_-]*\.myshopify\.com$/.test(shopParam);
  const specInfo =
    needsPlanGate && looksLikeRealDoc
      ? getSubscriptionInfo(shopParam).catch((err: any) => {
          console.warn(`[App Loader] getSubscriptionInfo paralelo falló (${shopParam}): ${err?.message || err}`);
          return null;
        })
      : null;

  const { session, redirect: appRedirect } = await withTimeout(safeAuthenticate(request), 15000, "safeAuthenticate");
  const tl1 = Date.now();
  const shopDomain = session.shop;
  const shopCookie = `${SHOP_COOKIE}=${encodeURIComponent(shopDomain)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;

  try {
    let hasPlan: boolean;
    let gateSub: Promise<SubscriptionInfo> | null = null;
    if (!needsPlanGate) {
      hasPlan = true;
    } else if (isDeveloperStore(shopDomain)) {
      // Dev: bypass sin llamada de billing (el planLabel "Dev" no la necesita).
      hasPlan = true;
    } else {
      const spec = specInfo && shopParam === shopDomain.toLowerCase() ? await specInfo : null;
      const info = spec ?? (await withTimeout(getSubscriptionInfo(shopDomain), 8000, "getSubscriptionInfo"));
      gateSub = Promise.resolve(info);
      hasPlan = info.hasActiveSubscription;
    }

    // Shopify App Pricing: sin contrato → fuera de la app, a la página de
    // planes alojada de Shopify (target _top sale del iframe). Solo documentos
    // reales: las peticiones .data siguen su curso (navegación SPA) — el
    // gate volverá a aplicar en la próxima carga de documento.
    if (!hasPlan && !url.pathname.endsWith(".data")) {
      const plansUrl = buildPlansUrl(shopDomain);
      console.log(`[App Loader] Sin plan activo (${shopDomain}) → bounce a planes alojados`);
      const isEmbeddedDoc =
        url.searchParams.get("embedded") === "1" &&
        request.method.toUpperCase() === "GET" &&
        !request.headers.get("authorization");
      if (isEmbeddedDoc) {
        // Bounce inline: navega la ventana top en el PRIMER parse del
        // documento, sin cargar el script de App Bridge (CDN) — antes el
        // iframe esperaba a cdn.shopify.com y parecía un refresco lento.
        // location.replace no crea entrada de historial: Back no re-dispara
        // el gate. Fallback al patrón oficial window.open(..., "_top").
        throw new Response(
          `<script data-plans-gate>try{window.top.location.replace(${JSON.stringify(plansUrl)})}catch(e){window.open(${JSON.stringify(plansUrl)},"_top")}</script>`,
          { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } }
        );
      }
      throw appRedirect(plansUrl, { target: "_top" });
    }

    const tl2 = Date.now();
    const [counts, subscription] = await withTimeout(
      Promise.all([
        getNavCounts(shopDomain, hasPlan),
        gateSub ?? withTimeout(getSubscriptionInfo(shopDomain), 8000, "getSubscriptionInfo"),
      ]),
      10000,
      "loader Promise.all"
    );

    const planLabel = subscription.isDeveloper ? "Dev" :
      subscription.isTrial ? `${subscription.planHandle} (trial)` :
      subscription.hasActiveSubscription ? subscription.planHandle : null;

    const tl3 = Date.now();
    console.log(
      `[Timing] app-layout ${url.pathname}: auth=${tl1 - tl0} gate=${tl2 - tl1} counts=${tl3 - tl2} total=${tl3 - tl0}`
    );

    return data({
      apiKey: process.env.SHOPIFY_API_KEY || "",
      shopDomain,
      unresolvedCount: counts.unresolved,
      queueCount: counts.queue,
      planLabel,
      hasPlan,
    }, { headers: { "Set-Cookie": shopCookie } });
  } catch (error: any) {
    // Redirects/respuestas del helper `redirect` (gate a planes alojados,
    // App Bridge bounce) deben propagarse, no devolver defaults.
    if (error instanceof Response) throw error;
    console.error(`[App Loader] Error (returning defaults): ${error?.message}`);
    return data({
      apiKey: process.env.SHOPIFY_API_KEY || "",
      shopDomain,
      unresolvedCount: 0,
      queueCount: 0,
      planLabel: null,
      hasPlan: (isBillingPage || isTutorialPage) ? true : false,
    }, { headers: { "Set-Cookie": shopCookie } });
  }
};

export default function App() {
  const { apiKey, shopDomain, unresolvedCount, queueCount, planLabel, hasPlan } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const { revalidate } = useRevalidator();

  // Auto-refresh queue count every 20s and when tab becomes visible
  // Use longer interval to avoid overwhelming server during imports
  useEffect(() => {
    if (!hasPlan) return;
    const interval = setInterval(revalidate, 20000);
    const onVisible = () => { if (document.visibilityState === "visible") revalidate(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasPlan, revalidate]);

  // Listen for fetch failures and trigger reconnect on auth/infra errors
  // Debounced: only trigger once per 10s to prevent reload loops
  // MUST be before the early return to respect React hooks rules
  useEffect(() => {
    let lastReconnect = 0;
    const DEBOUNCE_MS = 10000;
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      try {
        const res = await origFetch(...args);
        if (Date.now() - lastReconnect > DEBOUNCE_MS) {
          if (res.status === 502) {
            // Error de infra (Railway en deploy/devuelto HTML) — siempre recuperar
            lastReconnect = Date.now();
            console.warn(`[Network] HTTP 502 detected. Triggering reconnect...`);
            triggerReconnect();
          } else if (res.status === 401) {
            const ct = res.headers.get("content-type") || "";
            if (ct.includes("text/html")) {
              // Página de auth/bounce HTML de Shopify — que App Bridge renueve el
              // token nativamente, sin nuestro overlay
              console.warn("[Network] HTTP 401 HTML (auth bounce) — dejando renovación nativa a App Bridge");
            } else {
              lastReconnect = Date.now();
              console.warn(`[Network] HTTP 401 detected. Triggering reconnect...`);
              triggerReconnect();
            }
          }
        }
        return res;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        if (err instanceof TypeError && Date.now() - lastReconnect > DEBOUNCE_MS) {
          // Solo fallos de red de endpoints propios (relativos u origen actual);
          // un tercero caído no debe recargar nuestra app en bucle
          const target = typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].toString() : (args[0] as any)?.url || "";
          const isOwn = target === "" || target.startsWith("/") || target.startsWith(window.location.origin);
          if (isOwn) {
            lastReconnect = Date.now();
            console.warn(`[Network] Fetch failed for ${target || "?"} (network error). Triggering reconnect...`);
            triggerReconnect();
          }
        }
        throw err;
      }
    };

    // Detect Shopify FEC 421 errors (Frontend Controller) via PerformanceObserver
    // These cause infinite spinner — force reload to recover
    let fecFailures = 0;
    const FEC_THRESHOLD = 3;
    const perfObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const resource = entry as PerformanceResourceTiming;
        if (resource.name.includes(".well-known/shopify/fec/") && (resource as any).responseStatus === 421) {
          fecFailures++;
          console.warn(`[FEC] 421 error detected (${fecFailures}/${FEC_THRESHOLD})`);
          if (fecFailures >= FEC_THRESHOLD && Date.now() - lastReconnect > DEBOUNCE_MS) {
            lastReconnect = Date.now();
            console.warn("[FEC] Threshold reached. Triggering reconnect...");
            triggerReconnect();
          }
        }
      }
    });
    try { perfObserver.observe({ type: "resource", buffered: true }); } catch {}

    return () => { window.fetch = origFetch; perfObserver.disconnect(); };
  }, []);

  const navigate = useNavigate();
  const location = useLocation();

  // Guardar ruta actual y restaurarla tras rebote de auth (ver bloques superiores)
  useEffect(() => {
    if (!location.pathname.startsWith("/app")) return;

    const current = `${location.pathname}${stripVolatileParams(location.search)}`;
    const isRemount = docLoaded;
    docLoaded = true;

    if (isRemount && location.pathname === "/app") {
      const saved = sessionStorage.getItem(LAST_ROUTE_KEY);
      if (
        saved &&
        saved !== "/app" &&
        saved.startsWith("/app") &&
        Date.now() - lastRestoreAt > RESTORE_COOLDOWN_MS
      ) {
        lastRestoreAt = Date.now();
        sessionStorage.removeItem(LAST_ROUTE_KEY);
        console.log(`[RouteRestore] Rebote de auth detectado → restaurando ${saved}`);
        navigate(saved, { replace: true });
        return;
      }
    }

    // También en el primer monte: una apertura nueva (F5 en dashboard, NavMenu)
    // debe sobrescribir la ruta guardada para que un rebote posterior no
    // restaure una página que ya no es la última visitada.
    sessionStorage.setItem(LAST_ROUTE_KEY, current);
  }, [location.pathname, location.search, navigate]);

  // Guardar el contexto volatile mientras la URL lo trae. Si después una
  // recarga de documento deja la URL sin `shop`/`host` (deploy con pestaña
  // abierta, F5, URL SPA desnuda), AppBridgeBounce lo lee para volver al
  // admin con la ruta actual y que Shopify re-embeda con params frescos.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const shop = params.get("shop");
    if (!shop) return;
    const ctx = new URLSearchParams();
    ctx.set("shop", shop);
    for (const key of ["host", "locale"]) {
      const value = params.get(key);
      if (value) ctx.set(key, value);
    }
    if (params.get("embedded") === "1") ctx.set("embedded", "1");
    try {
      sessionStorage.setItem(CTX_KEY, ctx.toString());
    } catch {}
  }, [location.search]);

  if (!hasPlan) {
    return (
      <AppProvider apiKey={apiKey}>
        <Outlet />
      </AppProvider>
    );
  }

  return (
    <AppProvider apiKey={apiKey}>
      <TutorialProvider>
        <ReconnectingOverlay />
        <ClientOnly>
          <NavMenu>
            <a href="/app" rel="home" onClick={handleNavClick}>{t("nav.dashboard")}</a>
            <a href="/app/queue" onClick={handleNavClick}>
              {t("nav.queue")} {queueCount > 0 ? `(${queueCount})` : ""}
            </a>
            <a href="/app/duplicates" onClick={handleNavClick}>
              {t("nav.duplicates")} {unresolvedCount > 0 ? `(${unresolvedCount})` : ""}
            </a>
            <a href="/app/settings" onClick={handleNavClick}>{t("nav.settings")}</a>
            <a href="/app/billing" onClick={handleNavClick}>
              {t("nav.billing")} {planLabel ? `(${planLabel})` : ""}
            </a>
            <a href="/app/tutorial" onClick={handleNavClick}>{t("nav.tutorial")}</a>
          </NavMenu>
        </ClientOnly>
        <Outlet />
        <ClientOnly>
          <CrispChat shopDomain={shopDomain} />
        </ClientOnly>
      </TutorialProvider>
    </AppProvider>
  );
}

function AutoRedirect({ url, delayMs }: { url: string; delayMs?: number }) {
  useEffect(() => {
    const timer = setTimeout(() => { window.location.href = url; }, delayMs ?? 0);
    return () => clearTimeout(timer);
  }, [url, delayMs]);
  return null;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();

  const rrStatus = isRouteErrorResponse(error) ? error.status : 0;
  const rawStatus = error instanceof Response ? error.status : 0;
  const status = rrStatus || rawStatus;

  const redirectUrl = isRouteErrorResponse(error)
    ? (error.data instanceof Response ? error.data.headers.get("Location") : null)
    : error instanceof Response
    ? error.headers.get("Location")
    : null;

  const isAppBridgeHtml = isRouteErrorResponse(error)
    && error.status === 200
    && typeof error.data === "string"
    && (error.data.includes("app-bridge") || error.data.includes("data-plans-gate"));

  if (redirectUrl) {
    console.log(`[App ErrorBoundary] Redirect detected → ${redirectUrl}`);
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
        <p style={{ fontSize: "14px", color: "#6d7175" }}>Redirigiendo...</p>
        <AutoRedirect url={redirectUrl} />
      </div>
    );
  }

  if (isAppBridgeHtml) {
    console.log("[App ErrorBoundary] Bounce HTML (App Bridge o gate de planes) — entregando al navegador");
    return <AppBridgeBounce html={typeof error.data === "string" ? error.data : ""} />;
  }

  const errorText = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}: ${JSON.stringify(error.data)}`
    : error instanceof Response
    ? `${error.status} ${error.statusText || "Response"}`
    : error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);

  console.error(`[App ErrorBoundary] status=${status} error=${errorText}`);

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
      <div style={{ textAlign: "center", color: "#6d7175" }}>
        <div style={{ width: "24px", height: "24px", border: "3px solid #ddd", borderTopColor: "#006fbb", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <p style={{ fontSize: "14px" }}>Cargando...</p>
      </div>
      <AutoRedirect url={`/app${location.search}`} delayMs={2000} />
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
