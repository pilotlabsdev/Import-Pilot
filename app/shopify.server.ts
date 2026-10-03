import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  DeliveryMethod,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { shopifyApi, type BillingConfigRecurringLineItem } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { redirect } from "react-router";
import { prisma } from "~/lib/db.server";
import { ADMIN_ORIGIN, buildAdminAppUrl, shopFromCookieHeader } from "~/lib/admin-link";
import { PLAN_HANDLES, PLAN_LIMITS } from "~/lib/plans";
import { EventEmitter } from "node:events";

// Aviso conocido de Node: BrotliCompress (compresión HTTP de Railway) supera los
// 10 listeners por emitter. process.setMaxListeners NO sirve para esto (solo
// afecta al emitter `process`) — hay que subir el default por emitter.
EventEmitter.defaultMaxListeners = 50;

export { PLAN_HANDLES, PLAN_LIMITS };

function recurring(amount: number, interval: BillingInterval.Every30Days | BillingInterval.Annual = BillingInterval.Every30Days): BillingConfigRecurringLineItem {
  return {
    amount,
    currencyCode: "USD",
    interval,
  };
}

const BILLING_PLANS = {
  [PLAN_HANDLES.BASIC_MONTHLY]: {
    lineItems: [recurring(24.99)],
  },
  [PLAN_HANDLES.BASIC_ANNUAL]: {
    lineItems: [recurring(249.99, BillingInterval.Annual)],
  },
  [PLAN_HANDLES.GROWTH_MONTHLY]: {
    lineItems: [recurring(49.99)],
  },
  [PLAN_HANDLES.GROWTH_ANNUAL]: {
    lineItems: [recurring(499.99, BillingInterval.Annual)],
  },
  [PLAN_HANDLES.PRO_MONTHLY]: {
    lineItems: [recurring(74.99)],
  },
  [PLAN_HANDLES.PRO_ANNUAL]: {
    lineItems: [recurring(749.99, BillingInterval.Annual)],
  },
  [PLAN_HANDLES.BUSINESS_MONTHLY]: {
    lineItems: [recurring(124.99)],
  },
  [PLAN_HANDLES.BUSINESS_ANNUAL]: {
    lineItems: [recurring(1249.99, BillingInterval.Annual)],
  },
};

export function isDeveloperStore(shopDomain: string): boolean {
  const stores = (process.env.DEVELOPER_STORES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return stores.includes(shopDomain);
}

// Config API compartida. shopifyApp() NO expone .utils/.api en su objeto
// retornado, así que se crea además una instancia OFICIAL de
// @shopify/shopify-api con la misma config para usar utils.sanitizeShop y
// utils.sanitizeHost (validación de parámetros shop/host en safeAuthenticate).
// Esa instancia SOLO se usa para eso: auth/webhooks van por shopifyApp().
const SHOPIFY_API_CONFIG = {
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  scopes: process.env.SCOPES?.split(",") ?? [],
  appUrl: process.env.SHOPIFY_APP_URL!,
  apiVersion: ApiVersion.July26,
};

const shopifyCore = shopifyApi({
  ...SHOPIFY_API_CONFIG,
  hostName: new URL(SHOPIFY_API_CONFIG.appUrl).host,
  isEmbeddedApp: true,
});

const shopify = shopifyApp({
  ...SHOPIFY_API_CONFIG,
  distribution: AppDistribution.AppStore,
  sessionStorage: new PrismaSessionStorage(prisma),
  billing: BILLING_PLANS,
  future: {
    expiringOfflineAccessTokens: true,
  },
  webhooks: {
    APP_UNINSTALLED: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    BULK_OPERATIONS_FINISH: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    PRODUCTS_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    INVENTORY_ITEMS_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    INVENTORY_LEVELS_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    CUSTOMERS_DATA_REQUEST: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    CUSTOMERS_REDACT: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    SHOP_REDACT: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    PRODUCTS_DELETE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    APP_SUBSCRIPTIONS_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
  },
  hooks: {
    afterAuth: async ({ session }) => {
      // Webhooks (app/uninstalled, bulk_operations/finish, products/*, inventory_items/*)
      // are registered via shopify.app.toml [webhooks] section — not via GraphQL API.
      // registerWebhooks() was removed because it requires write_webhooks scope which
      // we don't have, and it was causing 401 errors that could block the auth flow.

      try {
        const existingSessions = await prisma.session.findMany({
          where: { shop: session.shop },
          select: { id: true, expires: true, accessToken: true, isOnline: true },
        });
        console.log(`[Shopify] afterAuth: ${session.shop} has ${existingSessions.length} existing session(s) before cleanup`);

        const deletedSessions = await prisma.session.deleteMany({
          where: {
            shop: session.shop,
            id: { not: session.id },
          },
        });
        if (deletedSessions.count > 0) {
          console.log(`[Shopify] Cleaned up ${deletedSessions.count} stale session(s) for ${session.shop}`);
        }

        const finalSessions = await prisma.session.findMany({
          where: { shop: session.shop },
          select: { id: true, expires: true, accessToken: true },
        });
        console.log(`[Shopify] afterAuth: ${session.shop} now has ${finalSessions.length} session(s): [${finalSessions.map(s => `id=${s.id},expires=${s.expires?.toISOString() || "null"},token=${s.accessToken ? "present" : "MISSING"}`).join("; ")}]`);

        const existingSettings = await prisma.shopSettings.findUnique({
          where: { shopDomain: session.shop },
        });

        if (existingSettings && !existingSettings.active) {
          await prisma.shopSettings.update({
            where: { shopDomain: session.shop },
            data: { active: true, uninstalledAt: null },
          });
          console.log(`[Shopify] Shop ${session.shop} reactivado tras reinstalación`);
          // Re-armar timers de importaciones (se limpiaron al desinstalar).
          // Import dinámico para no crear ciclo con scheduler.server → shopify.server
          void import("~/lib/scheduler.server")
            .then((m) => m.refreshSchedules())
            .catch(() => {});
        }
      } catch (err: any) {
        console.error(`[Shopify] afterAuth: cleanup failed for ${session.shop}: ${err?.message || err}`);
      }

      console.log(`[Shopify] afterAuth complete: shop=${session.shop}, scope=${session.scope}, accessToken=${session.accessToken ? "present" : "MISSING"}`);
    },
  },
});

export default shopify;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;

/**
 * Respuesta de bounce para documentos top-level que llegan SIN el parámetro
 * `shop` (F5 con foco en el iframe — el fetch pasa por nuestro Service Worker
 * con dest=empty+mode=navigate —, URL SPA desnuda, pestaña stale).
 * Devuelve null si la petición no debe intervenirse: lleva `shop`, es una
 * petición .data/prefetch (dest=empty, mode=cors) o está embebida
 * (dest=iframe / Referer=admin → sigue el bounce oficial de App Bridge).
 *
 * NUNCA un 302: si la petición vive dentro del iframe, el navegador seguiría
 * la redirección DENTRO del marco → admin.shopify.com responde
 * X-Frame-Options: deny (pantalla del gatito). El HTML con script funciona en
 * ambos contextos (top===self en documento puro).
 *
 * OJO (bug corregido aquí): React Router ejecuta en paralelo los loaders
 * padre (/app) e hijo (/app/queue, /app/supplier/...). Los hijos llaman a
 * safeAuthenticate → 401 sin sesión → redirect("/") — un redirect de hijo LE
 * GANA al error lanzado por el padre → la respuesta final era un 302 dentro
 * del iframe → gatito. Por eso este bounce se lanza TAMBIÉN desde
 * safeAuthenticate: padre e hijo lanzan la MISMA respuesta 200 con script y
 * el ErrorBoundary de /app la renderiza (marker `data-loader-bounce`).
 * Cada llamada crea una Response NUEVA: su body solo puede leerse una vez.
 */
// RR pasa instancias de Request DIFERENTES a cada loader (comprobado en E2E),
// así que la dedupe es por clave (ruta+dest+mode) en una ventana de 3s: el
// loader padre y los hijos disparan el bounce en el mismo milisegundo →
// UNA línea por petición en vez de 2-3. Nivel info: el bounce es la ruta
// esperada (sana), no un error.
const bounceLoggedAt = new Map<string, number>();
const BOUNCE_DEDUP_MS = 3_000;

export async function shoplessBounceResponse(request: Request, label = "loader"): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) return null;
  const dest = (request.headers.get("Sec-Fetch-Dest") || "").toLowerCase();
  const mode = (request.headers.get("Sec-Fetch-Mode") || "").toLowerCase();
  const accept = request.headers.get("Accept") || "";
  const referer = request.headers.get("Referer") || "";
  if (dest === "iframe" || referer.startsWith(ADMIN_ORIGIN)) return null;
  const isTopLevelDocument =
    dest === "document" ||
    mode === "navigate" ||
    (dest === "" && mode === "" && accept.includes("text/html"));
  if (!isTopLevelDocument) return null;

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
  const now = Date.now();
  const dedupeKey = `${url.pathname}|${dest}|${mode}`;
  if (now - (bounceLoggedAt.get(dedupeKey) ?? 0) > BOUNCE_DEDUP_MS) {
    bounceLoggedAt.set(dedupeKey, now);
    if (bounceLoggedAt.size > 200) {
      for (const [key, at] of bounceLoggedAt) if (now - at > BOUNCE_DEDUP_MS) bounceLoggedAt.delete(key);
    }
    console.info(`[Bounce:${label}] URL sin shop en ${url.pathname} → bounce a ${target} (fuente: ${source || "universal"}, dest=${dest || "-"}, mode=${mode || "-"}, referer=${refHost})`);
  }
  return new Response(
    `<script data-loader-bounce>try{window.top.location.replace(${JSON.stringify(target)})}catch(e){window.open(${JSON.stringify(target)},"_top")}</script>`,
    { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } }
  );
}

/**
 * Safe wrapper around authenticate.admin() that handles session expiry gracefully.
 * When the session is expired, the library throws a raw Response(401).
 * This wrapper catches it and redirects to "/" which triggers App Bridge session refresh.
 * Uses throw redirect() so React Router follows it automatically (no ErrorBoundary).
 */
export async function safeAuthenticate(request: Request) {
  // Documento top-level sin `shop` → bounce inline (ver shoplessBounceResponse).
  // Sin esto, el 401 de un loader HIJO → redirect("/") le ganaría al bounce
  // del loader padre y la respuesta final sería un 302 dentro del iframe.
  const shoplessBounce = await shoplessBounceResponse(request, "safeAuthenticate");
  if (shoplessBounce) throw shoplessBounce;
  try {
    // Pre-validación con los helpers OFICIALES utils.sanitizeShop/sanitizeHost
    // (solo se llaman si el parámetro está presente). Sin ella, shops/hosts de
    // fuzzing de revisión provocan HTML App Bridge inútil o TypeError
    // (ERR_INVALID_URL) en sanitizeHost que React Router responde como 500.
    const params = new URL(request.url).searchParams;
    const rawShop = params.get("shop");
    if (rawShop !== null) {
      const cleanShop = shopifyCore.utils.sanitizeShop(rawShop);
      if (!cleanShop) {
        console.warn(`[Auth] shop inválido descartado: ${rawShop.slice(0, 80)}`);
        throw new Response("Invalid shop parameter", { status: 400 });
      }
    }
    const rawHost = params.get("host");
    if (rawHost !== null) {
      let cleanHost: string | null = null;
      try {
        cleanHost = shopifyCore.utils.sanitizeHost(rawHost);
      } catch {
        cleanHost = null;
      }
      if (!cleanHost) {
        console.warn(`[Auth] host inválido descartado`);
        throw new Response("Invalid host parameter", { status: 400 });
      }
    }
    const ta0 = Date.now();
    const authResult = await authenticate.admin(request);
    console.log(`[Timing] authenticate.admin: ${Date.now() - ta0}ms`);
    return authResult;
  } catch (res: any) {
    // Fallback: cualquier TypeError de URL interna de la librería → 400.
    if (!(res instanceof Response) && (res?.code === "ERR_INVALID_URL" || res instanceof TypeError)) {
      console.warn(`[Auth] parámetros inválidos: ${String(res?.message || res).slice(0, 120)}`);
      throw new Response("Invalid request parameters", { status: 400 });
    }
    if (res instanceof Response) {
      // Follow any redirect (302/307 OAuth redirects, 401 session expiry, etc.)
      const location = res.headers.get("Location");
      if (location) {
        throw res;
      }
      // 401/410 without Location — redirect to / to trigger App Bridge session refresh
      if (res.status === 401 || res.status === 410) {
        throw redirect("/");
      }
    }
    throw res;
  }
}