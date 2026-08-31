import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRouteError, useRevalidator, redirect } from "react-router";
import { useState, useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  Page,
  Banner,
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";

import { authenticate } from "~/shopify.server";
import { PLAN_HANDLES, PLAN_LIMITS, PLAN_INFO } from "~/lib/plans";
import {
  getSubscriptionInfo,
  upsertSubscription,
  calculateTrialDays,
  calculateCarryoverTrialDays,
  enforcePlanLimits,
} from "~/lib/billing.server";

const FEATURES = [
  { label: "billing.suppliers", values: ["1", "2", "3", "5"] },
  { label: "billing.productsPerSupplier", values: ["billing.unlimited", "billing.unlimited", "billing.unlimited", "billing.unlimited"] },
  { label: "billing.priceFormulas", check: true },
  { label: "billing.categoryMapping", check: true },
  { label: "billing.duplicateDetection", check: true },
  { label: "billing.scheduling", check: true },
  { label: "billing.upload", check: true },
  { label: "billing.columnMapping", check: true },
  { label: "billing.previewImport", check: true },
  { label: "billing.modes", check: true },
  { label: "billing.liveSupport", check: true },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const planHandle = url.searchParams.get("plan_handle");
  const chargeId = url.searchParams.get("charge_id");

  if (planHandle) {
    const currentSubscription = await getSubscriptionInfo(shopDomain);

    if (chargeId && !currentSubscription.isDeveloper) {
      try {
        const { hasActivePayment } = await billing.check({
          plans: [planHandle],
        });
        if (!hasActivePayment) {
          console.log(`[Billing] Loader: charge ${chargeId} not approved for ${shopDomain}`);
          return redirect("/app/billing?error=payment_failed");
        }
      } catch (error: any) {
        console.log(`[Billing] Loader: billing.check failed for ${shopDomain}:`, error?.message);
        return redirect("/app/billing?error=verification_failed");
      }
    }

    const trialDaysRemaining = calculateCarryoverTrialDays(currentSubscription);
    const newTrialDays = calculateTrialDays(shopDomain, currentSubscription, trialDaysRemaining > 0 ? trialDaysRemaining : 14);
    const billingType = planHandle.endsWith("-annual") ? "annual" : "monthly";

    const isTrial = newTrialDays > 0;
    const status = isTrial ? "trial" : "active";
    const trialEndsAt = isTrial
      ? new Date(Date.now() + newTrialDays * 24 * 60 * 60 * 1000)
      : undefined;

    await upsertSubscription(shopDomain, planHandle, status, trialEndsAt, billingType);
    await enforcePlanLimits(shopDomain);
    return redirect("/app/billing");
  }

  const errorParam = url.searchParams.get("error");

  const subscription = await getSubscriptionInfo(shopDomain);

  return {
    shopDomain,
    subscription,
    plans: PLAN_INFO,
    errorParam,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[Billing Action] Called");
  const { billing, session } = await authenticate.admin(request);
  console.log("[Billing Action] Session:", session.shop);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const shopDomain = session.shop;
  console.log("[Billing Action] Intent:", intent, "Plan:", formData.get("planHandle"));

  if (intent === "subscribe") {
    const planHandle = formData.get("planHandle") as string;
    const billingType = planHandle.endsWith("-annual") ? "annual" : "monthly";

    const currentSubscription = await getSubscriptionInfo(shopDomain);
    const trialDaysRemaining = calculateCarryoverTrialDays(currentSubscription);
    const newTrialDays = calculateTrialDays(shopDomain, currentSubscription, trialDaysRemaining > 0 ? trialDaysRemaining : 14);

    const isTest = currentSubscription.isDeveloper;

    console.log("[Billing Action] Calling billing.request:", { planHandle, isTest, trialDays: newTrialDays });
    try {
      await billing.request({
        plan: planHandle as any,
        isTest,
        trialDays: newTrialDays,
        returnUrl: `${process.env.SHOPIFY_APP_URL}/app/billing`,
      });
    } catch (error: any) {
      console.log("[Billing Action] billing.request catch:", error?.constructor?.name, error?.message);

      if (error instanceof Response) {
        throw error;
      }

      if (currentSubscription.isDeveloper) {
        console.log("[Billing Action] Dev store — activando sin cobro real");
        const isTrial = newTrialDays > 0;
        const status = isTrial ? "trial" : "active";
        const trialEndsAt = isTrial
          ? new Date(Date.now() + newTrialDays * 24 * 60 * 60 * 1000)
          : undefined;
        await upsertSubscription(shopDomain, planHandle, status, trialEndsAt, billingType);
        await enforcePlanLimits(shopDomain);
        return { success: true };
      }

      const isUnpublished = error?.message?.includes("400") ||
        error?.message?.includes("Bad Request") ||
        error?.message?.includes("without a public distribution") ||
        error?.statusCode === 400;

      if (isUnpublished && process.env.BILLING_BYPASS === "true") {
        console.log("[Billing Action] App no publicada + BILLING_BYPASS=true — activando para desarrollo");
        const isTrial = newTrialDays > 0;
        const status = isTrial ? "trial" : "active";
        const trialEndsAt = isTrial
          ? new Date(Date.now() + newTrialDays * 24 * 60 * 60 * 1000)
          : undefined;
        await upsertSubscription(shopDomain, planHandle, status, trialEndsAt, billingType);
        await enforcePlanLimits(shopDomain);
        return { success: true };
      }

      console.error("[Billing Action] Error real en billing.request:", error.message);
      return { success: false, error: "billing.paymentError" };
    }

    return { success: true };
  }

  if (intent === "cancel") {
    const subscription = await getSubscriptionInfo(shopDomain);
    if (subscription.isDeveloper) {
      return { success: false, error: "billing.devStoreNotice" };
    }

    await upsertSubscription(shopDomain, subscription.planHandle, "cancelled");
    return { success: true };
  }

  return { success: false, error: "billing.invalidAction" };
};

function CheckIcon() {
  return (
    <span style={{ color: "#008060", fontWeight: "bold", fontSize: "18px" }}>
      ✓
    </span>
  );
}

export default function BillingPage() {
  const { subscription, plans, errorParam } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const { revalidate } = useRevalidator();
  const [isAnnual, setIsAnnual] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (fetcher.data?.success) {
      revalidate();
    }
  }, [fetcher.data, revalidate]);

  return (
    <Page title={t("billing.title")}>
      <BlockStack gap="600">
        {errorParam === "payment_failed" && (
          <Banner tone="critical" title={t("billing.paymentFailed")}>
            <p>{t("billing.paymentFailedDetail")}</p>
          </Banner>
        )}
        {errorParam === "verification_failed" && (
          <Banner tone="warning" title={t("billing.verificationFailed")}>
            <p>{t("billing.verificationFailedDetail")}</p>
          </Banner>
        )}
        {subscription.paymentFailed && (
          <Banner tone="critical" title={t("billing.paymentFailed")}>
            <p>{t("billing.paymentFailedDetail")}</p>
          </Banner>
        )}
        {subscription.hasActiveSubscription && (
          <Card>
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text variant="headingMd" as="h2">
                  {t("billing.currentPlan")}
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <Text variant="headingLg" as="h3">
                    {plans.find((p) => p.handle === subscription.planHandle)?.name || subscription.planHandle}
                  </Text>
                  <Text variant="bodyLg" as="p" tone="subdued">
                    {(() => {
                      const plan = plans.find((p) => p.handle === subscription.planHandle);
                      if (!plan) return "";
                      const price = plan.billingType === "annual" ? plan.monthlyEquivalent! : plan.price;
                      const display = price % 1 === 0 ? `$${price}` : `$${price.toFixed(2)}`;
                      return `${display}${t("billing.perMonth")}`;
                    })()}
                  </Text>
                </InlineStack>
              </BlockStack>
              <InlineStack gap="200" blockAlign="center">
                {subscription.isTrial && (
                  <Badge tone="info">
                    {t("billing.trialDays", { days: subscription.trialDaysRemaining })}
                  </Badge>
                )}
                {subscription.billingType === "annual" && (
                  <Badge tone="success">{t("billing.annual")}</Badge>
                )}
                {subscription.isDeveloper && (
                  <Badge tone="success">{t("billing.developer")}</Badge>
                )}
              </InlineStack>
            </InlineStack>
            <div style={{ marginTop: "12px" }}>
                {isAnnual && subscription.billingType === "monthly" && subscription.planHandle.endsWith("-monthly") && (
                  <fetcher.Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="subscribe" />
                    <input type="hidden" name="planHandle" value={subscription.planHandle.replace("-monthly", "-annual")} />
                    <Button submit size="slim" variant="primary">
                      {t("billing.switchAnnual")}
                    </Button>
                  </fetcher.Form>
                )}
                {!isAnnual && subscription.billingType === "annual" && subscription.planHandle.endsWith("-annual") && (
                  <fetcher.Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="subscribe" />
                    <input type="hidden" name="planHandle" value={subscription.planHandle.replace("-annual", "-monthly")} />
                    <Button submit size="slim">
                      {t("billing.switchMonthly")}
                    </Button>
                  </fetcher.Form>
                )}
              </div>
          </Card>
        )}

        <Card>
          <BlockStack gap="400">
            <div style={{ display: "flex", justifyContent: "center" }}>
              <div style={{
                display: "inline-flex",
                borderRadius: "8px",
                border: "1px solid #e1e3e5",
                overflow: "hidden",
              }}>
                <button
                  onClick={() => setIsAnnual(false)}
                  style={{
                    padding: "8px 20px",
                    border: "none",
                    background: !isAnnual ? "#202223" : "transparent",
                    color: !isAnnual ? "#fff" : "#202223",
                    cursor: "pointer",
                    fontWeight: 500,
                    fontSize: "14px",
                  }}
                >
                  {t("billing.payMonthly")}
                </button>
                <button
                  onClick={() => setIsAnnual(true)}
                  style={{
                    padding: "8px 20px",
                    border: "none",
                    background: isAnnual ? "#202223" : "transparent",
                    color: isAnnual ? "#fff" : "#202223",
                    cursor: "pointer",
                    fontWeight: 500,
                    fontSize: "14px",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  {t("billing.payAnnual")}
                  <Badge tone="success">{t("billing.savePercent")}</Badge>
                </button>
              </div>
            </div>

            <div style={{
              display: "grid",
              gridTemplateColumns: "1.5fr repeat(4, 1fr)",
              gap: "0",
            }}>
              <div style={{ padding: "16px" }}></div>
              {plans
                .filter((p) => p.billingType === (isAnnual ? "annual" : "monthly"))
                .map((plan) => {
                  const isCurrent = subscription.planHandle === plan.handle;
                  const price = plan.billingType === "annual" ? plan.monthlyEquivalent! : plan.price;
                  const displayPrice = price % 1 === 0 ? `$${price}` : `$${price.toFixed(2)}`;

                  return (
                    <div key={plan.handle} style={{
                      padding: "16px",
                      borderTop: isCurrent ? "3px solid #008060" : "3px solid transparent",
                      background: isCurrent ? "#f0faf5" : "#fff",
                      borderRadius: isCurrent ? "8px 8px 0 0" : "0",
                      border: isCurrent ? "1px solid #008060" : "1px solid #e1e3e5",
                      borderBottom: "none",
                      position: "relative",
                    }}>
                      {isCurrent && (
                        <div style={{
                          position: "absolute",
                          top: "-12px",
                          left: "50%",
                          transform: "translateX(-50%)",
                        }}>
                          <Badge tone="success">{t("billing.currentBadge")}</Badge>
                        </div>
                      )}
                      <BlockStack gap="200">
                        <Text variant="headingMd" as="h3">
                          {plan.name}
                        </Text>
                        <InlineStack gap="100" blockAlign="baseline" align="center">
                          <Text variant="headingXl" as="p">
                            {displayPrice}
                          </Text>
                          <Text variant="bodySm" as="p" tone="subdued">
                            {t("billing.perMonth")}
                          </Text>
                        </InlineStack>
                        {plan.billingType === "annual" && (
                          <Text variant="bodySm" as="p" tone="subdued">
                            ${plan.price}{t("billing.perYear")}
                          </Text>
                        )}
                        <Badge tone="info">
                          {subscription.hasUsedTrial ? t("billing.noTrial") : t("billing.freeTrial")}
                        </Badge>
                        <Text variant="bodyMd" as="p" alignment="center">
                          {t("billing.supplierCount", { count: plan.supplierCount })}
                        </Text>

                        {!isCurrent && (
                          <fetcher.Form method="post">
                            <input type="hidden" name="intent" value="subscribe" />
                            <input type="hidden" name="planHandle" value={plan.handle} />
                            <Button
                              submit
                              variant="primary"
                              size="slim"
                            >
                              {t("billing.selectPlan", { planName: plan.name })}
                            </Button>
                          </fetcher.Form>
                        )}
                      </BlockStack>
                    </div>
                  );
                })}

              {FEATURES.map((feature, i) => (
                <div key={i} style={{ display: "contents" }}>
                  <div style={{
                    padding: "14px 16px",
                    borderBottom: "1px solid #e1e3e5",
                    fontWeight: i < 2 ? "600" : "400",
                    display: "flex",
                    alignItems: "center",
                  }}>
                    {t(feature.label)}
                  </div>
                  {plans
                    .filter((p) => p.billingType === (isAnnual ? "annual" : "monthly"))
                    .map((plan, j) => {
                      const isCurrent = subscription.planHandle === plan.handle;
                      return (
                        <div key={plan.handle} style={{
                        textAlign: "center",
                        padding: "14px 16px",
                        borderBottom: "1px solid #e1e3e5",
                        borderLeft: isCurrent ? "1px solid #008060" : "1px solid #e1e3e5",
                        borderRight: isCurrent ? "1px solid #008060" : "1px solid #e1e3e5",
                        background: isCurrent ? "#f0faf5" : "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}>
                        {feature.check ? (
                          <CheckIcon />
                        ) : (
                          <Text variant="bodyMd" as="span">
                            {feature.values?.[j] && t(feature.values[j])}
                          </Text>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </BlockStack>
        </Card>

        <Text variant="bodySm" as="p" tone="subdued" alignment="center">
          {t("billing.trialInfo")}
        </Text>
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs: any) => {
  return boundary.headers(headersArgs);
};
