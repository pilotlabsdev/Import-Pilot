import { prisma } from "./db.server";

export type DuplicateCheckResult = {
  isDuplicate: boolean;
  shouldSkip: boolean;
  shouldReplace: boolean;
  existingSupplierName?: string;
  existingSku?: string;
  existingMappingId?: string;
  existingShopifyProductId?: string;
  existingConfigId?: string;
};

/**
 * Check if a product with the same EAN already exists from another supplier.
 * Returns whether to skip based on the shop's duplicate policy.
 */
export async function checkDuplicate(
  shopDomain: string,
  currentConfigId: string,
  ean: string,
  newSku?: string
): Promise<DuplicateCheckResult> {
  if (!ean || !ean.trim()) {
    return { isDuplicate: false, shouldSkip: false, shouldReplace: false };
  }

  // Find ALL existing mappings with the same EAN from DIFFERENT suppliers
  const existingMappings = await prisma.productMapping.findMany({
    where: {
      shopDomain,
      ean: ean.trim(),
      configId: { not: currentConfigId },
    },
    include: {
      config: { select: { id: true, name: true } },
    },
  });

  if (existingMappings.length === 0) {
    return { isDuplicate: false, shouldSkip: false, shouldReplace: false };
  }

  // Get the shop's duplicate policy
  const settings = await prisma.shopSettings.findUnique({
    where: { shopDomain },
  });

  const policy = settings?.duplicatePolicy || "create_both";

  switch (policy) {
    case "create_both":
      return {
        isDuplicate: true,
        shouldSkip: false,
        shouldReplace: false,
        existingSupplierName: existingMappings[0].config.name,
        existingSku: existingMappings[0].supplierSku,
      };

    case "priority": {
      const priorityJson = settings?.supplierPriority;
      if (!priorityJson) {
        await logDuplicate(shopDomain, ean, existingMappings[0], currentConfigId, newSku);
        return {
          isDuplicate: true,
          shouldSkip: true,
          shouldReplace: false,
          existingSupplierName: existingMappings[0].config.name,
          existingSku: existingMappings[0].supplierSku,
        };
      }

      let priorityList: string[];
      try {
        priorityList = JSON.parse(priorityJson);
      } catch {
        await logDuplicate(shopDomain, ean, existingMappings[0], currentConfigId, newSku);
        return {
          isDuplicate: true,
          shouldSkip: true,
          shouldReplace: false,
          existingSupplierName: existingMappings[0].config.name,
          existingSku: existingMappings[0].supplierSku,
        };
      }

      // Find the "winner" among all existing mappings (lowest index = highest priority)
      let winner = existingMappings[0];
      let winnerIndex = priorityList.indexOf(winner.configId);
      for (const m of existingMappings) {
        const idx = priorityList.indexOf(m.configId);
        if (winnerIndex === -1 || (idx !== -1 && idx < winnerIndex)) {
          winner = m;
          winnerIndex = idx;
        }
      }

      const currentIndex = priorityList.indexOf(currentConfigId);

      // Current supplier has LOWER or equal priority than the winner → skip
      if (currentIndex === -1 || (winnerIndex !== -1 && winnerIndex <= currentIndex)) {
        await logDuplicate(shopDomain, ean, winner, currentConfigId, newSku);
        return {
          isDuplicate: true,
          shouldSkip: true,
          shouldReplace: false,
          existingSupplierName: winner.config.name,
          existingSku: winner.supplierSku,
        };
      }

      // Current supplier has HIGHER priority than the winner → replace the winner
      return {
        isDuplicate: true,
        shouldSkip: false,
        shouldReplace: true,
        existingSupplierName: winner.config.name,
        existingSku: winner.supplierSku,
        existingMappingId: winner.id,
        existingShopifyProductId: winner.shopifyProductId,
        existingConfigId: winner.configId,
      };
    }

    case "skip_existing": {
      const anyExisting = await prisma.productMapping.findFirst({
        where: {
          shopDomain,
          ean: ean.trim(),
          configId: { not: currentConfigId },
        },
      });

      if (anyExisting) {
        await logDuplicate(shopDomain, ean, anyExisting, currentConfigId, newSku);
        return {
          isDuplicate: true,
          shouldSkip: true,
          shouldReplace: false,
          existingSupplierName: "Otro proveedor",
          existingSku: anyExisting.supplierSku,
        };
      }

      return { isDuplicate: false, shouldSkip: false, shouldReplace: false };
    }

    default:
      return { isDuplicate: false, shouldSkip: false, shouldReplace: false };
  }
}

export async function logDuplicate(
  shopDomain: string,
  ean: string,
  existingMapping: { supplierSku: string; configId: string; config?: { name: string }; shopifyProductId: string },
  newConfigId: string,
  newSku?: string
) {
  // Check if this exact duplicate pair already logged
  const existing = await prisma.duplicateLog.findFirst({
    where: {
      shopDomain,
      ean,
      supplierA_id: existingMapping.configId,
      supplierB_id: newConfigId,
    },
  });

  if (existing) return; // Already logged

  // Get the new supplier's name
  const newConfig = await prisma.importConfig.findUnique({
    where: { id: newConfigId },
    select: { name: true },
  });

  // Try to get the product title from the existing mapping's product
  let title = "Desconocido";
  try {
    title = `Producto (${existingMapping.shopifyProductId})`;
  } catch {}

  await prisma.duplicateLog.create({
    data: {
      shopDomain,
      ean,
      supplierA_id: existingMapping.configId,
      supplierA_name: existingMapping.config?.name || "Proveedor desconocido",
      supplierA_sku: existingMapping.supplierSku,
      supplierA_title: title,
      supplierB_id: newConfigId,
      supplierB_name: newConfig?.name || "Proveedor actual",
      supplierB_sku: newSku || "",
      supplierB_title: "Importación actual",
    },
  });
}

/**
 * Log a duplicate found against an external/manual Shopify product (no ProductMapping).
 */
export async function logExternalDuplicate(
  shopDomain: string,
  ean: string,
  shopifyProductId: string,
  supplierSku: string,
  configId: string,
  configName: string
) {
  const existing = await prisma.duplicateLog.findFirst({
    where: {
      shopDomain,
      ean,
      supplierA_id: "EXTERNAL",
      supplierB_id: configId,
    },
  });

  if (existing) return;

  await prisma.duplicateLog.create({
    data: {
      shopDomain,
      ean,
      supplierA_id: "EXTERNAL",
      supplierA_name: "Ya creado en Shopify",
      supplierA_sku: "",
      supplierA_title: shopifyProductId,
      supplierB_id: configId,
      supplierB_name: configName,
      supplierB_sku: supplierSku,
      supplierB_title: "Importación actual",
    },
  });
}
