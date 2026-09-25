import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, isRouteErrorResponse } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { useTranslation } from "react-i18next";
import { useState, useEffect } from "react";
import { useRevalidator } from "react-router";

import { safeAuthenticate } from "~/shopify.server";
import { prisma } from "~/lib/db.server";
import { TutorialProvider, stopTutorial } from "~/components/TutorialProvider";
import { CrispChat } from "~/components/CrispChat";
import { requireSubscription, getSubscriptionInfo } from "~/lib/billing.server";
import { ReconnectingOverlay, triggerReconnect } from "~/components/ReconnectingOverlay";
import { AppBridgeBounce } from "~/components/AppBridgeBounce";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[App Loader] Timeout ${label}: ${ms}ms`)), ms)
    ),
  ]);
}

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
  const { session } = await withTimeout(safeAuthenticate(request), 15000, "safeAuthenticate");
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const isBillingPage = url.pathname === "/app/billing";
  const isTutorialPage = url.pathname.startsWith("/app/tutorial");

  try {
    const hasPlan = (isBillingPage || isTutorialPage) ? true : await withTimeout(requireSubscription(shopDomain), 8000, "requireSubscription");

    const [unresolvedCount, queueCount, subscription] = await withTimeout(Promise.all([
      hasPlan ? prisma.duplicateLog.count({
        where: { shopDomain, resolved: false },
      }) : Promise.resolve(0),
      hasPlan ? (async () => {
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
    ]), 10000, "loader Promise.all");

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
  } catch (error: any) {
    console.error(`[App Loader] Error (returning defaults): ${error?.message}`);
    return {
      apiKey: process.env.SHOPIFY_API_KEY || "",
      shopDomain,
      unresolvedCount: 0,
      queueCount: 0,
      planLabel: null,
      hasPlan: (isBillingPage || isTutorialPage) ? true : false,
    };
  }
};

export default function App() {
  const { apiKey, shopDomain, unresolvedCount, queueCount, planLabel, hasPlan } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const { revalidate } = useRevalidator();

  // Auto-refresh queue count every 20s and when tab becomes visible
  // Use longer interval to avoid overwhelming server during imports
  useEffect(() => {
    if (!hasPlan) return;
    const interval = setInterval(revalidate, 20000);
    const onVisible = () => { if (document.visibilityState === "visible") revalidate(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasPlan, revalidate]);

  // Listen for fetch failures and trigger reconnect on auth/infra errors
  // Debounced: only trigger once per 10s to prevent reload loops
  // MUST be before the early return to respect React hooks rules
  useEffect(() => {
    let lastReconnect = 0;
    const DEBOUNCE_MS = 10000;
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      try {
        const res = await origFetch(...args);
        if ((res.status === 401 || res.status === 502) && Date.now() - lastReconnect > DEBOUNCE_MS) {
          lastReconnect = Date.now();
          console.warn(`[Network] HTTP ${res.status} detected. Triggering reconnect...`);
          triggerReconnect();
        }
        return res;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        const url = typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].toString() : (args[0] as any)?.url || "";
        if ((url.includes(".data") || url.includes("/app")) && Date.now() - lastReconnect > DEBOUNCE_MS) {
          lastReconnect = Date.now();
          console.warn(`[Network] Fetch failed for ${url}. Triggering reconnect...`);
          triggerReconnect();
        }
        throw err;
      }
    };

    // Detect Shopify FEC 421 errors (Frontend Controller) via PerformanceObserver
    // These cause infinite spinner — force reload to recover
    let fecFailures = 0;
    const FEC_THRESHOLD = 3;
    const perfObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const resource = entry as PerformanceResourceTiming;
        if (resource.name.includes(".well-known/shopify/fec/") && (resource as any).responseStatus === 421) {
          fecFailures++;
          console.warn(`[FEC] 421 error detected (${fecFailures}/${FEC_THRESHOLD})`);
          if (fecFailures >= FEC_THRESHOLD && Date.now() - lastReconnect > DEBOUNCE_MS) {
            lastReconnect = Date.now();
            console.warn("[FEC] Threshold reached. Triggering reconnect...");
            triggerReconnect();
          }
        }
      }
    });
    try { perfObserver.observe({ type: "resource", buffered: true }); } catch {}

    return () => { window.fetch = origFetch; perfObserver.disconnect(); };
  }, []);

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
        <ReconnectingOverlay />
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

function AutoRedirect({ url, delayMs }: { url: string; delayMs?: number }) {
  useEffect(() => {
    const timer = setTimeout(() => { window.location.href = url; }, delayMs ?? 0);
    return () => clearTimeout(timer);
  }, [url, delayMs]);
  return null;
}

export function ErrorBoundary() {
  const error = useRouteError();

  const rrStatus = isRouteErrorResponse(error) ? error.status : 0;
  const rawStatus = error instanceof Response ? error.status : 0;
  const status = rrStatus || rawStatus;

  const redirectUrl = isRouteErrorResponse(error)
    ? (error.data instanceof Response ? error.data.headers.get("Location") : null)
    : error instanceof Response
    ? error.headers.get("Location")
    : null;

  const isAppBridgeHtml = isRouteErrorResponse(error)
    && error.status === 200
    && typeof error.data === "string"
    && error.data.includes("app-bridge");

  if (redirectUrl) {
    console.log(`[App ErrorBoundary] Redirect detected → ${redirectUrl}`);
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
        <p style={{ fontSize: "14px", color: "#6d7175" }}>Redirigiendo...</p>
        <AutoRedirect url={redirectUrl} />
      </div>
    );
  }

  if (isAppBridgeHtml) {
    console.error("[App ErrorBoundary] App Bridge bounce HTML (sesión embedded perdida) — entregando al navegador para recuperación");
    return <AppBridgeBounce html={typeof error.data === "string" ? error.data : ""} />;
  }

  const errorText = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}: ${JSON.stringify(error.data)}`
    : error instanceof Response
    ? `${error.status} ${error.statusText || "Response"}`
    : error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);

  console.error(`[App ErrorBoundary] status=${status} error=${errorText}`);

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
      <div style={{ textAlign: "center", color: "#6d7175" }}>
        <div style={{ width: "24px", height: "24px", border: "3px solid #ddd", borderTopColor: "#006fbb", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <p style={{ fontSize: "14px" }}>Cargando...</p>
      </div>
      <AutoRedirect url="/app" delayMs={2000} />
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
