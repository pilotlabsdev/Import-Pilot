import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { prisma, getOrCreateConfig } from "~/lib/db.server";
import { safeAuthenticate } from "~/shopify.server";

async function discoverLocations(admin: any) {
  const locationMap = new Map<string, { id: string; name: string; isActive: boolean; fulfillsOnlineOrders: boolean }>();

  const locResponse = await admin.graphql(
    `#graphql
    query {
      locations(first: 50, includeInactive: true, includeLegacy: true) {
        edges {
          node {
            id
            name
            isActive
            isFulfillmentService
            fulfillsOnlineOrders
            address {
              city
              countryCode
            }
          }
        }
      }
    }`
  );

  const locJson = await locResponse.json();
  const locs = locJson.data?.locations?.edges || [];
  for (const l of locs) {
    if (!locationMap.has(l.node.id)) {
      locationMap.set(l.node.id, { id: l.node.id, name: l.node.name, isActive: l.node.isActive, fulfillsOnlineOrders: l.node.fulfillsOnlineOrders || false });
    }
  }

  if (locationMap.size > 0) return Array.from(locationMap.values());

  const response = await admin.graphql(
    `#graphql
    query {
      products(first: 250) {
        edges {
          node {
            variants(first: 10) {
              edges {
                node {
                  inventoryItem {
                    inventoryLevels(first: 50) {
                      edges {
                        node {
                          location {
                            id
                            name
                            isActive
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`
  );

  const json = await response.json();
  const products = json.data?.products?.edges || [];

  for (const product of products) {
    const variants = product.node?.variants?.edges || [];
    for (const variant of variants) {
      const levels = variant.node?.inventoryItem?.inventoryLevels?.edges || [];
      for (const level of levels) {
        const loc = level.node?.location;
        if (loc && !locationMap.has(loc.id)) {
          locationMap.set(loc.id, { id: loc.id, name: loc.name, isActive: loc.isActive, fulfillsOnlineOrders: false });
        }
      }
    }
  }

  return Array.from(locationMap.values());
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await safeAuthenticate(request);
  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "";

  const locations = await discoverLocations(admin);

  // Sort: default Shopify location first (fulfillsOnlineOrders), then active, then by name
  locations.sort((a, b) => {
    if (a.fulfillsOnlineOrders !== b.fulfillsOnlineOrders) return a.fulfillsOnlineOrders ? -1 : 1;
    const aActive = a.isActive ? 1 : 0;
    const bActive = b.isActive ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return a.name.localeCompare(b.name);
  });

  const config = shopDomain
    ? await getOrCreateConfig(shopDomain)
    : null;

  return data({
    locations,
    selectedId: config?.locationId || "",
    selectedName: config?.locationName || "",
    defaultId: locations[0]?.id || "",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await safeAuthenticate(request);
  const formData = await request.formData();
  const shopDomain = formData.get("shop") as string;
  const configId = formData.get("configId") as string || "";
  const locationId = formData.get("locationId") as string || "";
  const locationName = formData.get("locationName") as string || "";

  if (!shopDomain) return data({ error: "shop required" });

  const targetConfig = configId
    ? await prisma.importConfig.findUnique({ where: { id: configId } })
    : await getOrCreateConfig(shopDomain);

  if (!targetConfig) return data({ error: "Config not found" });

  await prisma.importConfig.update({
    where: { id: targetConfig.id },
    data: { locationId, locationName },
  });

  return data({ success: true });
};
