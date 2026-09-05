import { prisma } from "./db.server";

interface NotificationPayload {
  shopDomain: string;
  status: string;
  totalProducts: number;
  created: number;
  updated: number;
  unchanged: number;
  priceChanges: number;
  stockChanges: number;
  costChanges: number;
  errors: Array<{ sku: string; error: string; lineNumber?: number }>;
  duration: string;
}

export async function sendNotification(payload: NotificationPayload): Promise<void> {
  const config = await prisma.notificationConfig.findFirst({
    where: { shopDomain: payload.shopDomain },
  });

  if (!config) return;

  const hasErrors = payload.errors.length > 0;
  const shouldNotify =
    (payload.status === "completed" && config.notifyOnSuccess) ||
    (payload.status === "cancelled") ||
    (hasErrors && config.notifyOnError) ||
    (payload.priceChanges > 0 && config.notifyOnPriceChange);

  if (!shouldNotify) return;

  if (config.emailEnabled && config.emailAddresses) {
    const emails = JSON.parse(config.emailAddresses) as string[];
    console.log(`[Notification] Email a: ${emails.join(", ")}`);
  }

  if (config.webhookEnabled && config.webhookUrl) {
    try {
      await fetch(config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "import_completed",
          shop: payload.shopDomain,
          status: payload.status,
          summary: {
            total: payload.totalProducts,
            created: payload.created,
            updated: payload.updated,
            unchanged: payload.unchanged,
            priceChanges: payload.priceChanges,
            stockChanges: payload.stockChanges,
            costChanges: payload.costChanges,
            errors: payload.errors.length,
            duration: payload.duration,
          },
        }),
      });
    } catch (error) {
      console.error("[Notification] Error enviando webhook:", error);
    }
  }
}
