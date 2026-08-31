import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { useTranslation } from "react-i18next";

import { authenticate } from "~/shopify.server";
import { prisma } from "~/lib/db.server";
import { TutorialProvider, stopTutorial } from "~/components/TutorialProvider";
import { CrispChat } from "~/components/CrispChat";
import { requireSubscription, getSubscriptionInfo } from "~/lib/billing.server";

function handleNavClick(e: React.MouseEvent<HTMLAnchorElement>) {
  stopTutorial();
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const isBillingPage = url.pathname === "/app/billing";

  if (!isBillingPage) {
    const hasPlan = await requireSubscription(shopDomain);
    if (!hasPlan) {
      return redirect("/app/billing");
    }
  }

  const [unresolvedCount, queueCount, subscription] = await Promise.all([
    prisma.duplicateLog.count({
      where: { shopDomain, resolved: false },
    }),
    prisma.importQueue.count({
      where: { shopDomain, status: { in: ["queued", "running"] } },
    }),
    getSubscriptionInfo(shopDomain),
  ]);

  const planLabel = subscription.isDeveloper ? "Dev" :
    subscription.isTrial ? `${subscription.planHandle} (trial)` :
    subscription.hasActiveSubscription ? subscription.planHandle : null;

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shopDomain,
    unresolvedCount,
    queueCount,
    planLabel,
  };
};

export default function App() {
  const { apiKey, shopDomain, unresolvedCount, queueCount, planLabel } = useLoaderData<typeof loader>();
  const { t } = useTranslation();

  return (
    <AppProvider apiKey={apiKey}>
      <TutorialProvider>
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
        <Outlet />
        <CrispChat shopDomain={shopDomain} />
      </TutorialProvider>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
