import { prisma } from "./db.server";
import { PLAN_LIMITS, getBaseHandle } from "./plans";
import { isDeveloperStore } from "~/shopify.server";
import { fetchActiveSubscription, cancelSubscription } from "./partner-api.server";

export interface SubscriptionInfo {
  hasActiveSubscription: boolean;
  planHandle: string;
  billingType: string;
  supplierLimit: number;
  isTrial: boolean;
  trialEndsAt: Date | null;
  isDeveloper: boolean;
  hasUsedTrial: boolean;
  trialDaysRemaining: number;
  paymentFailed: boolean;
  shopifySubscriptionId: string | null;
}

// Tras aprobar un plan, Partner API puede tardar unos segundos en reflejar el
// contrato: si dice "sin contrato" pero la fila local es reciente, no la
// marques como cancelada todavía.
const MIRROR_CANCEL_GRACE_MS = 3 * 60_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function infoFromRow(
  subscription: {
    planHandle: string;
    billingType: string | null;
    status: string;
    trialEndsAt: Date | null;
    hasUsedTrial: boolean;
    shopifySubscriptionId: string | null;
  } | null,
  isDev: boolean
): SubscriptionInfo {
  if (!subscription) {
    return {
      hasActiveSubscription: isDev,
      planHandle: isDev ? "business-monthly" : "",
      billingType: "monthly",
      supplierLimit: isDev ? 5 : 0,
      isTrial: false,
      trialEndsAt: null,
      isDeveloper: isDev,
      hasUsedTrial: false,
      trialDaysRemaining: 0,
      paymentFailed: false,
      shopifySubscriptionId: null,
    };
  }

  const now = new Date();
  const isTrial =
    subscription.status === "trial" &&
    subscription.trialEndsAt !== null &&
    subscription.trialEndsAt > now;

  const trialDaysRemaining = isTrial && subscription.trialEndsAt
    ? Math.max(0, Math.ceil((subscription.trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
    : 0;

  const hasActive =
    subscription.status === "active" ||
    subscription.status === "trial";

  return {
    hasActiveSubscription: hasActive || isDev,
    planHandle: subscription.planHandle,
    billingType: subscription.billingType || "monthly",
    supplierLimit: PLAN_LIMITS[subscription.planHandle] || 0,
    isTrial,
    trialEndsAt: subscription.trialEndsAt,
    isDeveloper: isDev,
    hasUsedTrial: subscription.hasUsedTrial,
    trialDaysRemaining,
    paymentFailed: subscription.status === "payment_failed",
    shopifySubscriptionId: subscription.shopifySubscriptionId || null,
  };
}

export async function getSubscriptionInfo(
  shopDomain: string
): Promise<SubscriptionInfo> {
  const isDev = isDeveloperStore(shopDomain);

  // Tiendas dev del allow-list: bypass de billing tal cual (imports/pipeline).
  if (isDev) {
    return infoFromRow(await prisma.appSubscription.findUnique({ where: { shopDomain } }), true);
  }

  // Shopify App Pricing: la Partner API es la fuente de verdad; la fila local
  // es espejo + fallback si la API falla (nunca bloquear a un pagando).
  const partner = await fetchActiveSubscription(shopDomain);
  const row = await prisma.appSubscription.findUnique({ where: { shopDomain } });

  if (partner.ok) {
    const sub = partner.sub;

    if (!sub) {
      // Sin contrato → cancelación en espejo (gracia para propagación).
      if (
        row &&
        (row.status === "active" || row.status === "trial") &&
        Date.now() - row.updatedAt.getTime() > MIRROR_CANCEL_GRACE_MS
      ) {
        await prisma.appSubscription.update({
          where: { shopDomain },
          data: { status: "cancelled" },
        });
        console.log(`[Billing] Partner API sin contrato activo → ${row.planHandle} de ${shopDomain} marcada cancelled`);
        return infoFromRow({ ...row, status: "cancelled" }, false);
      }
      return infoFromRow(row, false);
    }

    // Contrato activo → espejar fila local y devolver datos derivados.
    const isTrial = sub.trialEndsAt !== null && sub.trialEndsAt > new Date();
    const planHandle = sub.planHandle || row?.planHandle || "";
    const billingType =
      planHandle.endsWith("-annual") || sub.billingPeriod === "ANNUAL" ? "annual" : "monthly";
    const mirrored = await upsertSubscription(
      shopDomain,
      planHandle,
      isTrial ? "trial" : "active",
      isTrial ? sub.trialEndsAt! : undefined,
      billingType,
      sub.legacySubscriptionId || undefined
    );
    return infoFromRow(mirrored, false);
  }

  // API no disponible (env/red/org) → fallback a la fila local.
  console.warn(
    `[Billing] Partner API no disponible para ${shopDomain} (${partner.error}) — usando fila local`
  );
  return infoFromRow(row, false);
}

export async function getSupplierCount(shopDomain: string): Promise<number> {
  return prisma.importConfig.count({
    where: { shopDomain },
  });
}

export async function canAddSupplier(shopDomain: string): Promise<boolean> {
  const [subscription, supplierCount] = await Promise.all([
    getSubscriptionInfo(shopDomain),
    getSupplierCount(shopDomain),
  ]);

  if (!subscription.hasActiveSubscription) return false;
  return supplierCount < subscription.supplierLimit;
}

export async function upsertSubscription(
  shopDomain: string,
  planHandle: string,
  status: string = "active",
  trialEndsAt?: Date,
  billingType: string = "monthly",
  shopifySubscriptionId?: string
) {
  const existing = await prisma.appSubscription.findUnique({
    where: { shopDomain },
  });

  const hasUsedTrial = existing?.hasUsedTrial || (status === "trial" && trialEndsAt != null);

  return prisma.appSubscription.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      planHandle,
      billingType,
      status,
      trialEndsAt: trialEndsAt || null,
      hasUsedTrial,
      shopifySubscriptionId: shopifySubscriptionId || null,
    },
    update: {
      planHandle,
      billingType,
      status,
      trialEndsAt: trialEndsAt || null,
      hasUsedTrial,
      ...(shopifySubscriptionId ? { shopifySubscriptionId } : {}),
    },
  });
}

export function calculateTrialDays(shopDomain: string, subscription: SubscriptionInfo, requestedTrialDays: number): number {
  if (isDeveloperStore(shopDomain)) return 0;
  if (subscription.hasUsedTrial) return 0;
  return requestedTrialDays;
}

export function calculateCarryoverTrialDays(subscription: SubscriptionInfo): number {
  if (!subscription.isTrial || !subscription.trialEndsAt) return 0;
  return subscription.trialDaysRemaining;
}

export async function enforcePlanLimits(shopDomain: string) {
  const te0 = Date.now();
  const subscription = await getSubscriptionInfo(shopDomain);
  const te1 = Date.now();
  const limit = subscription.supplierLimit;

  const configs = await prisma.importConfig.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "asc" },
  });
  const te2 = Date.now();

  const allNonPaused = configs.filter((c) => !c.planPaused);
  const excessConfigs = allNonPaused.slice(limit);

  if (excessConfigs.length > 0) {
    await prisma.importConfig.updateMany({
      where: { id: { in: excessConfigs.map((c) => c.id) } },
      data: { planPaused: true },
    });
    console.log(`[Billing] ${shopDomain}: ${excessConfigs.length} proveedor(es) pausado(s) por límite de plan (${subscription.planHandle}: ${limit})`);
  }

  // Re-fetch after pausing to get accurate paused list
  const updatedConfigs = await prisma.importConfig.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "asc" },
  });

  const activeConfigs = updatedConfigs.filter((c) => !c.planPaused);
  const pausedConfigs = updatedConfigs.filter((c) => c.planPaused);

  if (pausedConfigs.length > 0 && subscription.hasActiveSubscription) {
    const resumeSlots = Math.max(0, limit - activeConfigs.length);
    const toResume = pausedConfigs.slice(0, resumeSlots);
    if (toResume.length > 0) {
      await prisma.importConfig.updateMany({
        where: { id: { in: toResume.map((c) => c.id) } },
        data: { planPaused: false },
      });
      console.log(`[Billing] ${shopDomain}: ${toResume.length} proveedor(es) reactivado(s)`);
    }
  }
  console.log(
    `[Timing] enforce ${shopDomain}: sub=${te1 - te0} find1=${te2 - te1} total=${Date.now() - te0}`
  );
}

export async function requireSubscription(shopDomain: string): Promise<boolean> {
  if (isDeveloperStore(shopDomain)) return true;

  const info = await getSubscriptionInfo(shopDomain);
  return info.hasActiveSubscription;
}

export { cancelSubscription };

/**
 * Retorno del welcome link de Shopify App Pricing (plan_handle + shop).
 * Verifica el contrato en la Partner API antes de dar por bueno el plan
 * (reintentos por propagación). Si la API falla (env, red, app aún no
 * pública), se confía en el parámetro para no dejar el flujo muerto.
 */
export async function confirmSubscriptionReturn(
  shopDomain: string,
  planHandleParam: string
): Promise<boolean> {
  // La tienda debe tener sesión offline (app instalada) — además evita
  // escribir filas de suscripción para tiendas ajenas.
  const sessionRow = await prisma.session.findFirst({
    where: { shop: shopDomain },
    select: { id: true },
  });
  if (!sessionRow) {
    console.warn(`[Billing] Retorno con plan_handle para tienda sin sesión: ${shopDomain}`);
    return false;
  }

  let result = await fetchActiveSubscription(shopDomain, { force: true });
  for (let attempt = 0; attempt < 2 && result.ok && !result.sub; attempt++) {
    await sleep(1500);
    result = await fetchActiveSubscription(shopDomain, { force: true });
  }

  if (result.ok && result.sub) {
    const sub = result.sub;
    const isTrial = sub.trialEndsAt !== null && sub.trialEndsAt > new Date();
    const planHandle = sub.planHandle || planHandleParam;
    const billingType =
      planHandle.endsWith("-annual") || sub.billingPeriod === "ANNUAL" ? "annual" : "monthly";
    await upsertSubscription(
      shopDomain,
      planHandle,
      isTrial ? "trial" : "active",
      isTrial ? sub.trialEndsAt! : undefined,
      billingType,
      sub.legacySubscriptionId || undefined
    );
    await enforcePlanLimits(shopDomain);
    console.log(
      `[Billing] Retorno verificado vía Partner API: ${shopDomain} → ${planHandle} (trial=${isTrial})`
    );
    return true;
  }

  if (result.ok) {
    // API OK pero sin contrato: param posiblemente falsificado o no propagado.
    console.warn(
      `[Billing] Retorno rechazado: Partner API sin contrato para ${shopDomain} (plan_handle=${planHandleParam})`
    );
    return false;
  }

  console.warn(
    `[Billing] Partner API no disponible (${result.error}) — confiando en plan_handle=${planHandleParam} para ${shopDomain}`
  );
  const billingType = planHandleParam.endsWith("-annual") ? "annual" : "monthly";
  await upsertSubscription(shopDomain, planHandleParam, "active", undefined, billingType);
  await enforcePlanLimits(shopDomain);
  return true;
}
