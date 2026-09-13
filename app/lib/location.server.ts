import { prisma, getOrCreateConfig } from "./db.server";

export async function getLocationId(admin: any, shopDomain?: string, configId?: string): Promise<string> {
  // Try to use saved location from the specific supplier config
  if (configId) {
    const config = await prisma.importConfig.findUnique({
      where: { id: configId },
      select: { locationId: true, locationName: true },
    });
    if (config?.locationId) {
      return config.locationId;
    }
  }

  // Fallback: try base config
  if (shopDomain) {
    const baseConfig = await getOrCreateConfig(shopDomain);
    const config = await prisma.importConfig.findUnique({
      where: { id: baseConfig.id },
      select: { locationId: true, locationName: true },
    });

    if (config?.locationId) {
      return config.locationId;
    }
  }

  // Fallback: get Shopify's primary/default location
  // `location` (no args) returns the shop's primary location per Shopify docs
  const response = await admin.graphql(
    `#graphql
    query {
      location {
        id
        name
        isActive
      }
    }`
  );

  const json = await response.json();
  const location = json.data?.location;

  if (!location?.id) {
    throw new Error("No hay ubicación primaria en Shopify");
  }

  const locationId = location.id;
  const locationName = location.name;

  // Persist to the specific config or base config
  const targetConfigId = configId || (shopDomain ? (await getOrCreateConfig(shopDomain)).id : null);
  if (targetConfigId) {
    try {
      await prisma.importConfig.update({
        where: { id: targetConfigId },
        data: { locationId, locationName },
      });
      console.log(`[Location] Persisted default location "${locationName}" (${locationId}) for config ${targetConfigId}`);
    } catch (e: any) {
      console.error(`[Location] Error persisting location: ${e?.message}`);
    }
  }

  return locationId;
}
