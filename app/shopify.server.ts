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
 * Safe wrapper around authenticate.admin() that handles session expiry gracefully.
 * When the session is expired, the library throws a raw Response(401).
 * This wrapper catches it and redirects to "/" which triggers App Bridge session refresh.
 * Uses throw redirect() so React Router follows it automatically (no ErrorBoundary).
 */
export async function safeAuthenticate(request: Request) {
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