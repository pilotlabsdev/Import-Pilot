import { prisma, ensureSingleSession } from "./db.server";
import { getFreshAdminClient } from "./bulk-import.server";

const BATCH_SIZE = 50;
// Tope por pasada: con N merchants, recorrer todas las tiendas con GraphQL
// (batches de 50 ids) en un único tick puede superar el intervalo de 60min y
// solaparse con la siguiente pasada. Rotación por offset para cubrir todas
// en varias pasadas.
const SHOPS_PER_PASS = 20;
let reconcileInFlight = false;
let shopOffset = 0;

export async function reconcileOrphanedMappings(shopDomain: string): Promise<{ checked: number; deleted: number }> {
  await ensureSingleSession(shopDomain);
  const admin = await getFreshAdminClient(shopDomain);

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


  return { checked: uniqueProductIds.length, deleted: deleted.count };
}

export async function reconcileAllShops(): Promise<void> {
  // Guard de reentrada: la llamada del scheduler es fire-and-forget cada 60s
  // (reconcileCounter); si una pasada anterior sigue viva (GraphQL lento con
  // muchas tiendas) no se solapan dos — la segunda simplemente se salta.
  if (reconcileInFlight) return;
  reconcileInFlight = true;
  try {
    const shops = await prisma.productMapping.findMany({
      select: { shopDomain: true },
      distinct: ["shopDomain"],
      orderBy: { shopDomain: "asc" },
    });

    let slice = shops;
    if (shops.length > SHOPS_PER_PASS) {
      // Rotación: cada pasada cubre un tramo distinto para no castigar siempre
      // las mismas tiendas y completar el barrido en varias pasadas.
      const start = shopOffset % shops.length;
      shopOffset = (start + SHOPS_PER_PASS) % shops.length;
      slice = shops.slice(start, start + SHOPS_PER_PASS);
      console.log(
        `[Reconciliation] ${shops.length} tiendas con mappings — pasada de ${SHOPS_PER_PASS} (offset ${start})`
      );
    }

    for (const { shopDomain } of slice) {
      try {
        await reconcileOrphanedMappings(shopDomain);
      } catch (e: any) {
        console.error(`[Reconciliation] Error reconciling ${shopDomain}:`, e?.message);
      }
    }
  } finally {
    reconcileInFlight = false;
  }
}
