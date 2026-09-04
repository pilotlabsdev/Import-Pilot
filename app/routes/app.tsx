import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { useTranslation } from "react-i18next";
import { useState, useEffect } from "react";
import { useRevalidator } from "react-router";

import { authenticate } from "~/shopify.server";
import { prisma } from "~/lib/db.server";
import { TutorialProvider, stopTutorial } from "~/components/TutorialProvider";
import { CrispChat } from "~/components/CrispChat";
import { requireSubscription, getSubscriptionInfo } from "~/lib/billing.server";

function handleNavClick(e: React.MouseEvent<HTMLAnchorElement>) {
  stopTutorial();
}

function ClientOnly({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <nav style={{ height: "44px" }} />;
  return <>{children}</>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const isBillingPage = url.pathname === "/app/billing";

  const hasPlan = isBillingPage ? true : await requireSubscription(shopDomain);

  const [unresolvedCount, queueCount, subscription] = await Promise.all([
    hasPlan ? prisma.duplicateLog.count({
      where: { shopDomain, resolved: false },
    }) : Promise.resolve(0),
    hasPlan ? (async () => {
      // Count unique suppliers with active imports (queue, orphan logs, or bulk jobs)
      const activeConfigIds = new Set<string>();

      const qItems = await prisma.importQueue.findMany({
        where: { shopDomain, status: { in: ["queued", "running"] } },
        select: { configId: true },
      });
      for (const q of qItems) activeConfigIds.add(q.configId);

      const runningLogs = await prisma.importLog.findMany({
        where: { shopDomain, status: "running" },
        select: { configId: true },
      });
      for (const l of runningLogs) activeConfigIds.add(l.configId);

      const activeJobs = await prisma.bulkJob.findMany({
        where: { shopDomain, phase: { in: ["lookup", "mutations", "finalizing"] } },
        select: { configId: true },
      });
      for (const j of activeJobs) activeConfigIds.add(j.configId);

      return activeConfigIds.size;
    })() : Promise.resolve(0),
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
    hasPlan,
  };
};

export default function App() {
  const { apiKey, shopDomain, unresolvedCount, queueCount, planLabel, hasPlan } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const { revalidate } = useRevalidator();

  // Auto-refresh queue count every 15s and when tab becomes visible
  useEffect(() => {
    if (!hasPlan) return;
    const interval = setInterval(revalidate, 5000);
    const onVisible = () => { if (document.visibilityState === "visible") revalidate(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasPlan, revalidate]);

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

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
