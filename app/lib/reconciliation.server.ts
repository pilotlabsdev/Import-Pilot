import { prisma, ensureSingleSession } from "./db.server";
import shopify from "~/shopify.server";

const BATCH_SIZE = 50;

export async function reconcileOrphanedMappings(shopDomain: string): Promise<{ checked: number; deleted: number }> {
  await ensureSingleSession(shopDomain);
  const { admin } = await shopify.unauthenticated.admin(shopDomain);

  const mappings = await prisma.productMapping.findMany({
    where: { shopDomain },
    select: { id: true, shopifyProductId: true, supplierSku: true },
  });

  if (mappings.length === 0) return { checked: 0, deleted: 0 };

  const uniqueProductIds = [...new Set(mappings.map((m) => m.shopifyProductId))];
  const notFound = new Set<string>();

  for (let i = 0; i < uniqueProductIds.length; i += BATCH_SIZE) {
    const batch = uniqueProductIds.slice(i, i + BATCH_SIZE);
    try {
      const ids = batch.map((id) => `"${id}"`).join(", ");
      const res = await admin.graphql(
        `#graphql
        query { nodes(ids: [${ids}]) {
          ... on Product { id }
          ... on ProductVariant { id }
          ... on InventoryItem { id }
        }}`,
        {}
      );
      const json = await res.json();
      const existingIds = new Set(
        (json.data?.nodes || []).filter(Boolean).map((n: any) => n.id)
      );
      for (const id of batch) {
        if (!existingIds.has(id)) notFound.add(id);
      }
    } catch (e: any) {
      console.error(`[Reconciliation] Error checking batch for ${shopDomain}:`, e?.message);
    }
  }

  if (notFound.size === 0) return { checked: uniqueProductIds.length, deleted: 0 };

  const orphaned = mappings.filter((m) => notFound.has(m.shopifyProductId));
  const deleted = await prisma.productMapping.deleteMany({
    where: { id: { in: orphaned.map((m) => m.id) } },
  });

  for (const m of orphaned) {
    console.log(`[Reconciliation] Deleted orphaned mapping: SKU="${m.supplierSku}" productId=${m.shopifyProductId}`);
  }

  console.log(`[Reconciliation] ${shopDomain}: checked=${uniqueProductIds.length}, deleted=${deleted.count}`);
  return { checked: uniqueProductIds.length, deleted: deleted.count };
}

export async function reconcileAllShops(): Promise<void> {
  const shops = await prisma.productMapping.findMany({
    select: { shopDomain: true },
    distinct: ["shopDomain"],
  });

  for (const { shopDomain } of shops) {
    try {
      await reconcileOrphanedMappings(shopDomain);
    } catch (e: any) {
      console.error(`[Reconciliation] Error reconciling ${shopDomain}:`, e?.message);
    }
  }
}
