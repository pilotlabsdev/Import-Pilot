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

  // Fallback: get Shopify's default location (first active location)
  const response = await admin.graphql(
    `#graphql
    query {
      locations(first: 1, includeInactive: false) {
        edges {
          node {
            id
            name
            isActive
          }
        }
      }
    }`
  );

  const json = await response.json();
  const locations = json.data?.locations?.edges || [];

  if (locations.length === 0) {
    throw new Error("No hay ubicaciones activas en Shopify");
  }

  const locationId = locations[0].node.id;
  const locationName = locations[0].node.name;

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
