import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  DeliveryMethod,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import type { BillingConfigRecurringLineItem } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { prisma } from "~/lib/db.server";
import { PLAN_HANDLES, PLAN_LIMITS } from "~/lib/plans";

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

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  scopes: process.env.SCOPES?.split(",") ?? [],
  appUrl: process.env.SHOPIFY_APP_URL!,
  distribution: AppDistribution.AppStore,
  apiVersion: ApiVersion.July26,
  sessionStorage: new PrismaSessionStorage(prisma),
  billing: BILLING_PLANS,
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
      await shopify.registerWebhooks({ session });

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

      console.log("[Shopify] Webhooks registered via SDK");
    },
  },
});

export default shopify;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;