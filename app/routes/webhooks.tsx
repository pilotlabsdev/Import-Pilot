import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { prisma, ensureSingleSession } from "~/lib/db.server";
import shopify from "~/shopify.server";
import { handleBulkOperationFinish } from "~/lib/bulk-import.server";
import { isBulkActive } from "~/lib/bulk-active-cache.server";
import { enforcePlanLimits, upsertSubscription } from "~/lib/billing.server";
import crypto from "node:crypto";

const COMPLIANCE_TOPICS = new Set(["customers/data_request", "customers/redact", "shop/redact"]);

function verifyHmac(body: string, hmacHeader: string): boolean {
  const secret = process.env.SHOPIFY_API_SECRET || "";
  const calculated = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(calculated, "base64"), Buffer.from(hmacHeader, "base64"));
  } catch {
    return false;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const topicHeader = request.headers.get("X-Shopify-Topic") || "";
  const hmacHeader = request.headers.get("X-Shopify-Hmac-SHA256") || "";

  // Compliance webhooks: validate HMAC manually, return 200 always
  // (they arrive after app uninstall when session no longer exists)
  if (COMPLIANCE_TOPICS.has(topicHeader)) {
    const rawBody = await request.text();
    if (!verifyHmac(rawBody, hmacHeader)) {
      console.warn(`[Webhook] Compliance HMAC invalid for ${topicHeader}`);
      throw new Response(null, { status: 401 });
    }
    const payload = JSON.parse(rawBody);
    const shop = payload.shop_domain || "unknown";
    console.log(`[Webhook] Compliance: ${topicHeader} from ${shop} — OK (200)`);
    throw new Response(null, { status: 200 });
  }

  // All other webhooks: use library authentication (validates HMAC + finds session)
  let topic: string, shop: string, session: any, payload: any;
  try {
    ({ topic, shop, session, payload } = await authenticate.webhook(request));
  } catch (err: any) {
    console.warn(`[Webhook] HMAC validation failed: ${err?.message || err}`);
    throw new Response(null, { status: 401 });
  }
  console.log(`[Webhook] Received: topic=${topic}, shop=${shop}, session=${session ? "present" : "null"}`);

  if (!session) {
    console.warn(`[Webhook] No session for ${shop}, returning 410`);
    throw new Response(null, { status: 410 });
  }

  const graphqlTopic = topic.toUpperCase();

  switch (graphqlTopic) {
    case "APP_UNINSTALLED": {
      await prisma.shopSettings.upsert({
        where: { shopDomain: shop },
        update: { active: false, uninstalledAt: new Date() },
        create: { shopDomain: shop, active: false, uninstalledAt: new Date() },
      });
      await prisma.session.deleteMany({ where: { shop } });
      await prisma.importQueue.updateMany({
        where: { shopDomain: shop, status: { in: ["queued", "running"] } },
        data: { status: "cancelled", finishedAt: new Date() },
      });
      console.log(`[Webhook] APP_UNINSTALLED: ${shop} marcado como inactivo, sesiones y cola eliminadas`);
      break;
    }
    case "SHOP_REDACT": {
      await prisma.$transaction([
        prisma.importConfig.deleteMany({ where: { shopDomain: shop } }),
        prisma.productMapping.deleteMany({ where: { shopDomain: shop } }),
        prisma.importLog.deleteMany({ where: { shopDomain: shop } }),
        prisma.notificationConfig.deleteMany({ where: { shopDomain: shop } }),
        prisma.bulkJob.deleteMany({ where: { shopDomain: shop } }),
        prisma.shopSettings.deleteMany({ where: { shopDomain: shop } }),
      ]);
      console.log(`[Webhook] SHOP_REDACT: ${shop} datos eliminados definitivamente`);
      break;
    }
    case "BULK_OPERATIONS_FINISH": {
      const opId = payload.admin_graphql_api_id as string;
      const opStatus = (payload.status as string) || "unknown";
      console.log(`[Webhook] BULK_OPERATIONS_FINISH: opId=${opId}, status=${opStatus}, shop=${shop}`);
      if (opId) {
        // Deduplicate sessions before getting admin client
        const bestSession = await ensureSingleSession(shop);
        const isExpired = bestSession?.expires ? new Date(bestSession.expires) < new Date() : true;
        console.log(`[Webhook] Session for bulk finish: shop=${shop}, sessionExpired=${isExpired}, accessToken=${bestSession?.accessToken ? "present" : "MISSING"}`);

        if (!bestSession) {
          console.error(`[Webhook] No session for ${shop} after dedup, returning 410`);
          throw new Response(null, { status: 410 });
        }

        try {
          const { admin } = await shopify.unauthenticated.admin(shop);
          console.log(`[Webhook] Admin client created for bulk finish: shop=${shop}`);
          void handleBulkOperationFinish({
            admin,
            opId,
            status: opStatus,
          }).catch((error) =>
            console.error(`[Webhook] Error procesando bulk op ${opId}:`, error?.message || error)
          );
        } catch (e: any) {
          console.error(`[Webhook] No se pudo crear admin client para ${shop}:`, e?.message || e);
        }
      } else {
        console.log(`[Webhook] BULK_OPERATIONS_FINISH sin opId`);
      }
      break;
    }
    case "PRODUCTS_UPDATE": {
      // Skip during active bulk imports — bulk op already updates mappings (0 DB queries)
      if (isBulkActive(shop)) break;

      const productId = payload.id ? `gid://shopify/Product/${payload.id}` : null;
      if (!productId) break;

      const variants = (payload.variants as any[]) || [];
      const firstVariant = variants[0];
      if (!firstVariant) break;

      const mapping = await prisma.productMapping.findFirst({
        where: { shopDomain: shop, shopifyProductId: productId },
      });
      if (!mapping) break;

      const newPrice = firstVariant.price != null ? parseFloat(String(firstVariant.price)) : null;
      const newCompare = firstVariant.compare_at_price != null ? parseFloat(String(firstVariant.compare_at_price)) : null;
      const newQty = firstVariant.inventory_quantity != null ? parseInt(String(firstVariant.inventory_quantity), 10) : null;

      const priceUnchanged = newPrice != null && mapping.lastPrice === newPrice;
      const compareUnchanged = newCompare != null && mapping.lastComparePrice === newCompare;
      const qtyUnchanged = newQty != null && mapping.lastQuantity === newQty;

      if (priceUnchanged && compareUnchanged && qtyUnchanged) break;

      const patch: any = {};
      if (newPrice != null && !priceUnchanged) patch.lastPrice = newPrice;
      if (newCompare != null && !compareUnchanged) patch.lastComparePrice = newCompare;
      if (newQty != null && !qtyUnchanged) patch.lastQuantity = newQty;

      if (Object.keys(patch).length > 0) {
        await prisma.productMapping.update({
          where: { id: mapping.id },
          data: patch,
        });
        console.log(`[Webhook] PRODUCT_UPDATE SKU=${mapping.supplierSku}: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      }
      break;
    }
    case "PRODUCTS_DELETE": {
      const deletedId = payload.id ? `gid://shopify/Product/${payload.id}` : null;
      if (!deletedId) break;

      // Get the mapping before deleting (to get the EAN for duplicate cleanup)
      const mappingToDelete = await prisma.productMapping.findFirst({
        where: { shopDomain: shop, shopifyProductId: deletedId },
      });

      const deleted = await prisma.productMapping.deleteMany({
        where: { shopDomain: shop, shopifyProductId: deletedId },
      });
      if (deleted.count > 0) {
        console.log(`[Webhook] PRODUCT_DELETE: ${deleted.count} mapping(s) eliminados para ${deletedId}`);
      }

      // Clean up DuplicateLog records referencing this product's EAN
      if (mappingToDelete?.ean) {
        const dupDeleted = await prisma.duplicateLog.deleteMany({
          where: { shopDomain: shop, ean: mappingToDelete.ean },
        });
        if (dupDeleted.count > 0) {
          console.log(`[Webhook] PRODUCT_DELETE: ${dupDeleted.count} duplicate log(s) eliminados para EAN ${mappingToDelete.ean}`);
        }
      }

      // Also clean up "EXTERNAL" DuplicateLogs where supplierA_title is the deleted product ID
      const extDupDeleted = await prisma.duplicateLog.deleteMany({
        where: {
          shopDomain: shop,
          supplierA_id: "EXTERNAL",
          supplierA_title: deletedId,
        },
      });
      if (extDupDeleted.count > 0) {
        console.log(`[Webhook] PRODUCT_DELETE: ${extDupDeleted.count} external duplicate log(s) eliminados para ${deletedId}`);
      }
      break;
    }
    case "INVENTORY_ITEMS_UPDATE": {
      // Skip during active bulk imports — bulk op already updates cost (0 DB queries)
      if (isBulkActive(shop)) break;

      const inventoryItemId = payload.id ? `gid://shopify/InventoryItem/${payload.id}` : null;
      if (!inventoryItemId) break;

      const mapping = await prisma.productMapping.findFirst({
        where: { shopDomain: shop, shopifyInventoryItemId: inventoryItemId },
      });
      if (!mapping) break;

      try {
        await ensureSingleSession(shop);
        const { admin } = await shopify.unauthenticated.admin(shop);
        const costRes = await admin.graphql(
          `#graphql
          query invCost($id: ID!) {
            inventoryItem(id: $id) {
              unitCost { amount }
            }
          }`,
          { variables: { id: inventoryItemId } }
        );
        const costJson = await costRes.json();
        const newCost = parseFloat(costJson?.data?.inventoryItem?.unitCost?.amount ?? "0") || 0;

        if (newCost > 0 && newCost !== mapping.lastCost) {
          await prisma.productMapping.update({
            where: { id: mapping.id },
            data: { lastCost: newCost },
          });
          console.log(`[Webhook] INVENTORY_ITEM_UPDATE SKU=${mapping.supplierSku}: lastCost=${newCost}`);
        }
      } catch (e: any) {
        console.error(`[Webhook] Error consultando costo inventoryItem: ${e?.message}`);
      }
      break;
    }
    case "APP_SCOPES_UPDATE":
      console.log(`[Webhook] APP_SCOPES_UPDATE: ${shop}`);
      break;
    case "APP_SUBSCRIPTIONS_UPDATE": {
      const subscription = payload.app_subscription as any;
      if (!subscription) break;

      const planName = subscription.name as string;
      const subStatus = (subscription.status as string)?.toLowerCase() || "active";

      const validPlans = ["basic", "growth", "pro", "business"];
      const validPlan = validPlans.includes(planName) ? planName : null;

      const newStatus = subStatus === "active" ? "active"
        : subStatus === "cancelled" ? "cancelled"
        : subStatus === "frozen" ? "frozen"
        : subStatus === "pending" ? "trial"
        : subStatus === "payment_due" ? "payment_failed"
        : subStatus === "declined" ? "payment_failed"
        : null;

      if (newStatus === null) {
        console.log(`[Webhook] APP_SUBSCRIPTIONS_UPDATE: status desconocido "${subStatus}" para ${shop}, ignorando`);
        break;
      }

      await upsertSubscription(shop, validPlan || "basic", newStatus);

      if (newStatus === "cancelled" || newStatus === "frozen" || newStatus === "payment_failed" || validPlan) {
        await enforcePlanLimits(shop);
      }

      console.log(`[Webhook] APP_SUBSCRIPTIONS_UPDATE: ${shop} → plan=${validPlan}, status=${newStatus}`);
      break;
    }
    default:
      console.log(`Webhook recibido: ${topic} — ${JSON.stringify(payload)}`);
      break;
  }

  throw new Response(null, { status: 200 });
};