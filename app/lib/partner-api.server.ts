// Cliente mínimo de la Partner API de Shopify — fuente de verdad para
// Shopify App Pricing (activeSubscription / appSubscriptionCancel).
// La Billing API legacy está bloqueada al optar por App Pricing, así que la
// suscripción se lee y cancela desde aquí (org 4425275).
//
// Requiere env vars (SOLO env — nunca al repo):
//   SHOPIFY_PARTNER_ORG_ID, SHOPIFY_PARTNER_API_ACCESS_TOKEN
// (Partner Dashboard → Settings → Partner API clients; permisos:
//  View financials + Manage apps.)
import shopify from "~/shopify.server";
import { prisma } from "~/lib/db.server";

const PARTNER_API_VERSION = "2026-07";

export interface PartnerSubscription {
  planHandle: string | null;
  billingPeriod: string | null;
  trialEndsAt: Date | null;
  cancelAtEndOfCycle: boolean;
  legacySubscriptionId: string | null;
}

export type PartnerSubResult =
  | { ok: true; sub: PartnerSubscription | null }
  | { ok: false; error: string };

const ACTIVE_SUBSCRIPTION_QUERY = `#graphql
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      billingPeriod
      cancelAtEndOfCycle
      trialEndsAt
      legacySubscriptionId
      items { handle }
    }
  }
`;

const CANCEL_MUTATION = `#graphql
  mutation CancelAppSubscription($appId: ID!, $shopId: ID!, $prorate: Boolean!, $skipFinalUsageCharge: Boolean!, $deferCancellation: Boolean!) {
    appSubscriptionCancel(appId: $appId, shopId: $shopId, prorate: $prorate, skipFinalUsageCharge: $skipFinalUsageCharge, deferCancellation: $deferCancellation) {
      appSubscription {
        cancelledAt
        cancelAtEndOfCycle
      }
      userErrors { field message }
    }
  }
`;

// Caché por tienda: contrato positivo 5 min, null (sin contrato) 15 s,
// error de API 15 s (para no martillear Partner API cuando está caída).
type CacheEntry = { expires: number; result: PartnerSubResult };
const subCache = new Map<string, CacheEntry>();
const POSITIVE_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 15_000;

const shopGidCache = new Map<string, string>();
let appGidCache: string | null = null;

function partnerConfig(): { orgId: string; token: string } | null {
  const orgId = process.env.SHOPIFY_PARTNER_ORG_ID?.trim();
  const token = process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN?.trim();
  if (!orgId || !token) return null;
  return { orgId, token };
}

async function partnerFetch(
  query: string,
  variables: Record<string, unknown>
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const cfg = partnerConfig();
  if (!cfg) {
    return { ok: false, error: "SHOPIFY_PARTNER_ORG_ID/SHOPIFY_PARTNER_API_ACCESS_TOKEN no configurados" };
  }
  try {
    const res = await fetch(
      `https://partners.shopify.com/${cfg.orgId}/api/${PARTNER_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": cfg.token,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json: any = await res.json();
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      const msg = json.errors.map((e: any) => e?.message || JSON.stringify(e)).join("; ");
      return { ok: false, error: `GraphQL: ${msg}`.slice(0, 300) };
    }
    return { ok: true, data: json?.data };
  } catch (err: any) {
    const msg = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout 6s" : err?.message || String(err);
    return { ok: false, error: String(msg).slice(0, 300) };
  }
}

async function getShopGid(shopDomain: string): Promise<string | null> {
  const cached = shopGidCache.get(shopDomain);
  if (cached) return cached;
  // Sin sesión local no hay con qué llamar a la Admin API (probes/cross-shop
  // de la revisión) — se omite sin generar excepción ni warn.
  const hasSession = await prisma.session.findFirst({
    where: { shop: shopDomain },
    select: { id: true },
  });
  if (!hasSession) {
    console.log(`[PartnerAPI] getShopGid sin sesión local para ${shopDomain} — se omite (probable probe)`);
    return null;
  }
  try {
    const { admin } = await shopify.unauthenticated.admin(shopDomain);
    // admin.graphql() de shopify-app-react-router devuelve un Response
    // (new Response(JSON.stringify(body))) — hay que hacer .json().
    const res = await admin.graphql(`query { shop { id } }`);
    const json: any = await res.json();
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      console.warn(`[PartnerAPI] getShopGid errores GraphQL (${shopDomain}): ${JSON.stringify(json.errors).slice(0, 300)}`);
      return null;
    }
    const gid = json?.data?.shop?.id;
    if (typeof gid === "string" && gid) {
      shopGidCache.set(shopDomain, gid);
      return gid;
    }
    return null;
  } catch (err: any) {
    console.warn(`[PartnerAPI] getShopGid falló (${shopDomain}): ${err?.message || err}`);
    return null;
  }
}

async function getAppGid(admin: any): Promise<string | null> {
  if (appGidCache) return appGidCache;
  try {
    const res = await admin.graphql(`query { currentAppInstallation { app { id } } }`);
    const json: any = await res.json();
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      console.warn(`[PartnerAPI] getAppGid errores GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
      return null;
    }
    const gid = json?.data?.currentAppInstallation?.app?.id;
    if (typeof gid === "string" && gid) {
      appGidCache = gid;
      return gid;
    }
    return null;
  } catch (err: any) {
    console.warn(`[PartnerAPI] getAppGid falló: ${err?.message || err}`);
    return null;
  }
}

async function resolveGids(shopDomain: string): Promise<{ appGid: string; shopGid: string } | null> {
  const shopGid = await getShopGid(shopDomain);
  if (!shopGid) return null;
  let appGid = appGidCache;
  if (!appGid) {
    try {
      const { admin } = await shopify.unauthenticated.admin(shopDomain);
      appGid = await getAppGid(admin);
    } catch (err: any) {
      console.warn(`[PartnerAPI] resolveGids admin falló (${shopDomain}): ${err?.message || err}`);
      return null;
    }
  }
  if (!appGid) return null;
  return { appGid, shopGid };
}

/**
 * Contrato activo de Shopify App Pricing para una tienda (fuente de verdad).
 * ok:false = la API falló (env/red/app no pública aún) — el llamante decide
 * el fallback. ok:true + sub:null = verificado: no hay contrato.
 */
export async function fetchActiveSubscription(
  shopDomain: string,
  opts?: { force?: boolean }
): Promise<PartnerSubResult> {
  const now = Date.now();
  if (!opts?.force) {
    const hit = subCache.get(shopDomain);
    if (hit && hit.expires > now) return hit.result;
  }

  const t0 = Date.now();
  const gids = await resolveGids(shopDomain);
  if (!gids) {
    console.log(`[Timing] partner miss ${shopDomain}: gids=null total=${Date.now() - t0}`);
    const result: PartnerSubResult = { ok: false, error: "sin GIDs (sesión/instalación no disponible)" };
    subCache.set(shopDomain, { expires: now + NEGATIVE_TTL_MS, result });
    return result;
  }
  const t1 = Date.now();

  const res = await partnerFetch(ACTIVE_SUBSCRIPTION_QUERY, {
    appId: gids.appGid,
    shopId: gids.shopGid,
  });
  console.log(
    `[Timing] partner miss ${shopDomain}: gids=${t1 - t0} fetch=${Date.now() - t1} total=${Date.now() - t0} ok=${res.ok}${res.ok ? "" : " err=" + res.error}`
  );

  let result: PartnerSubResult;
  if (!res.ok) {
    result = { ok: false, error: res.error };
  } else {
    const raw = res.data?.activeSubscription;
    result = raw
      ? {
          ok: true,
          sub: {
            planHandle: raw.items?.[0]?.handle ?? null,
            billingPeriod: raw.billingPeriod ?? null,
            trialEndsAt: raw.trialEndsAt ? new Date(raw.trialEndsAt) : null,
            cancelAtEndOfCycle: Boolean(raw.cancelAtEndOfCycle),
            legacySubscriptionId: raw.legacySubscriptionId ?? null,
          },
        }
      : { ok: true, sub: null };
  }

  const ttl = result.ok ? (result.sub ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) : NEGATIVE_TTL_MS;
  subCache.set(shopDomain, { expires: now + ttl, result });
  return result;
}

/**
 * Cancela el contrato activo vía Partner API. Sin prorrateo, al final del
 * ciclo (deferCancellation) — el merchant conserva el acceso hasta pagar.
 */
export async function cancelSubscription(
  shopDomain: string
): Promise<{ ok: boolean; error?: string }> {
  const gids = await resolveGids(shopDomain);
  if (!gids) return { ok: false, error: "sin GIDs (sesión/instalación no disponible)" };

  const res = await partnerFetch(CANCEL_MUTATION, {
    appId: gids.appGid,
    shopId: gids.shopGid,
    prorate: false,
    skipFinalUsageCharge: false,
    deferCancellation: true,
  });
  if (!res.ok) return { ok: false, error: res.error };

  const payload = res.data?.appSubscriptionCancel;
  const userErrors: any[] = payload?.userErrors || [];
  if (userErrors.length > 0) {
    return { ok: false, error: userErrors.map((e) => e?.message || JSON.stringify(e)).join("; ") };
  }

  subCache.delete(shopDomain);
  return { ok: true };
}
