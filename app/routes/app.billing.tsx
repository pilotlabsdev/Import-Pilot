import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useRouteError, redirect } from "react-router";
import { useState } from "react";
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

import { safeAuthenticate } from "~/shopify.server";
import { PLAN_INFO } from "~/lib/plans";
import {
  getSubscriptionInfo,
  upsertSubscription,
  confirmSubscriptionReturn,
  cancelSubscription,
} from "~/lib/billing.server";
import { buildPlansUrl } from "~/lib/admin-link";

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
  const url = new URL(request.url);
  const planHandleParam = url.searchParams.get("plan_handle");
  const shopParam = url.searchParams.get("shop");

  // Retorno del welcome link de Shopify App Pricing: plan_handle + shop,
  // sin `host` (authenticate.admin rechazaría esa petición). Verificamos el
  // contrato en la Partner API ANTES de autenticar.
  if (planHandleParam && shopParam && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shopParam)) {
    // El helper de redirect de la app copia los query params actuales al
    // destino cuando es mismo origen: sin marcar `plan_handle=` vacío, un
    // redirect limpio re-añadiría plan_handle → bucle de verificación.
    try {
      const ok = await confirmSubscriptionReturn(shopParam, planHandleParam);
      if (ok) {
        return redirect("/app/billing?plan_handle=");
      }
      return redirect("/app/billing?plan_handle=&error=verification_failed");
    } catch (error: any) {
      console.error(`[Billing] Error verificando retorno de ${shopParam}:`, error?.message || error);
      return redirect("/app/billing?plan_handle=&error=verification_failed");
    }
  }

  const { session } = await safeAuthenticate(request);
  const shopDomain = session.shop;

  const errorParam = url.searchParams.get("error");
  const subscription = await getSubscriptionInfo(shopDomain);

  return {
    shopDomain,
    subscription,
    plans: PLAN_INFO,
    errorParam,
    hostedPlansUrl: buildPlansUrl(shopDomain),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await safeAuthenticate(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const shopDomain = session.shop;

  if (intent === "cancel") {
    const subscription = await getSubscriptionInfo(shopDomain);
    if (subscription.isDeveloper) {
      return { success: false, error: "billing.devStoreNotice" };
    }

    // Shopify App Pricing → cancelación vía Partner API (Billing API legacy
    // está bloqueada). Al final del ciclo, sin prorrateo.
    try {
      const result = await cancelSubscription(shopDomain);
      if (!result.ok) {
        console.error(`[Billing] appSubscriptionCancel falló para ${shopDomain}: ${result.error}`);
        return { success: false, error: "billing.cancelFailed" };
      }
      console.log(`[Billing] Suscripción cancelada vía Partner API para ${shopDomain}`);
    } catch (error: any) {
      console.error(`[Billing] Error cancelando para ${shopDomain}:`, error?.message || error);
      return { success: false, error: "billing.cancelFailed" };
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
  const { subscription, plans, errorParam, hostedPlansUrl } = useLoaderData<typeof loader>();
  const [isAnnual, setIsAnnual] = useState(false);
  const { t } = useTranslation();

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
                  <Button url={hostedPlansUrl} target="_top" size="slim">
                    {t("billing.switchAnnual")}
                  </Button>
                )}
                {!isAnnual && subscription.billingType === "annual" && subscription.planHandle.endsWith("-annual") && (
                  <Button url={hostedPlansUrl} target="_top" size="slim">
                    {t("billing.switchMonthly")}
                  </Button>
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
                          <Button
                            url={hostedPlansUrl}
                            target="_top"
                            variant="primary"
                            size="slim"
                          >
                            {t("billing.selectPlan", { planName: plan.name })}
                          </Button>
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
