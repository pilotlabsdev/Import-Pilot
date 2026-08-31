import { prisma } from "./db.server";
import { PLAN_LIMITS, getBaseHandle } from "./plans";
import { isDeveloperStore } from "~/shopify.server";

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
}

export async function getSubscriptionInfo(
  shopDomain: string
): Promise<SubscriptionInfo> {
  const isDev = isDeveloperStore(shopDomain);

  const subscription = await prisma.appSubscription.findUnique({
    where: { shopDomain },
  });

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
  };
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
  billingType: string = "monthly"
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
    },
    update: {
      planHandle,
      billingType,
      status,
      trialEndsAt: trialEndsAt || null,
      hasUsedTrial,
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
  const subscription = await getSubscriptionInfo(shopDomain);
  const limit = subscription.supplierLimit;

  const configs = await prisma.importConfig.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "asc" },
  });

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
}

export async function requireSubscription(shopDomain: string): Promise<boolean> {
  if (isDeveloperStore(shopDomain)) return true;

  const info = await getSubscriptionInfo(shopDomain);
  return info.hasActiveSubscription;
}
