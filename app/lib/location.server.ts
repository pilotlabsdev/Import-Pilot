import { prisma } from "./db.server";

export async function getLocationId(admin: any, shopDomain?: string, configId?: string): Promise<string> {
  // Use saved location from the specific supplier config
  if (configId) {
    const config = await prisma.importConfig.findUnique({
      where: { id: configId },
      select: { locationId: true, locationName: true },
    });
    if (config?.locationId) {
      return config.locationId;
    }
  }

  // No saved location — get Shopify's primary/default location
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

  // Persist to the specific config so next time it's instant
  if (configId) {
    try {
      await prisma.importConfig.update({
        where: { id: configId },
        data: { locationId, locationName },
      });
      console.log(`[Location] Persisted default location "${locationName}" (${locationId}) for config ${configId}`);
    } catch (e: any) {
      console.error(`[Location] Error persisting location: ${e?.message}`);
    }
  }

  return locationId;
}
