// Colecciones de la tienda, con distinción manual vs automática (ruleSet).
//
// IMPORTANTE (verificado 2026-07 sobre colecciones con reglas/smart):
// - collectionAddProducts / collectionRemoveProducts sobre una colección
//   automática se aceptan en silencio pero NO hacen nada (no-op).
// - productSet(collections: [...]) al crear SÍ fuerza una membresía manual,
//   contaminando la colección con productos que no cumplen sus reglas.
// Por eso el motor de importación y el picker de mapeo EXCLUYEN las
// colecciones con ruleSet != null: su membresía la gobiernan las reglas
// de Shopify, no la app.

const AUTO_COLLECTIONS_TTL_MS = 10 * 60 * 1000; // 10 min
const autoIdsCache = new Map<string, { ids: Set<string>; at: number }>();

/**
 * Colecciones MANUALES de la tienda (para el picker de mapeo de categorías).
 * Las automáticas (ruleSet != null) se excluyen: la app no debe gestionarlas.
 */
export async function getCollections(admin: any): Promise<Array<{ id: string; title: string }>> {
  const collections: Array<{ id: string; title: string }> = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const query = `#graphql
      query($first: Int!, $after: String) {
        collections(first: $first, after: $after) {
          edges {
            node {
              id
              title
              ruleSet {
                appliedDisjunctively
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`;

    const response: any = await admin.graphql(query, {
      variables: {
        first: 100,
        ...(cursor ? { after: cursor } : {}),
      },
    });

    const json = await response.json();
    const edges = json.data?.collections?.edges || [];

    for (const edge of edges) {
      // ruleSet != null => colección automática (reglas) => NO se muestra
      if (edge.node.ruleSet) continue;
      collections.push({ id: edge.node.id, title: edge.node.title });
    }

    hasNextPage = json.data?.collections?.pageInfo?.hasNextPage || false;
    cursor = json.data?.collections?.pageInfo?.endCursor || null;
  }

  return collections;
}

/**
 * IDs de colecciones AUTOMÁTICAS (ruleSet != null) de la tienda, con caché
 * de 10 minutos por tienda. El motor de importación las filtra para no
 * intentar add/remove/productSet sobre ellas (no-ops o contaminación).
 */
export async function getAutomaticCollectionIds(admin: any, shopDomain: string): Promise<Set<string>> {
  const hit = autoIdsCache.get(shopDomain);
  if (hit && Date.now() - hit.at < AUTO_COLLECTIONS_TTL_MS) return hit.ids;

  try {
    const ids = new Set<string>();
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const query = `#graphql
      query($first: Int!, $after: String) {
        collections(first: $first, after: $after) {
          edges {
            node {
              id
              ruleSet {
                appliedDisjunctively
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`;

      const response: any = await admin.graphql(query, {
        variables: {
          first: 100,
          ...(cursor ? { after: cursor } : {}),
        },
      });

      const json = await response.json();
      // GraphQL parcial (rate-limit, etc.): fallar en vez de cachear vacío
      if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
      const edges = json.data?.collections?.edges || [];

      for (const edge of edges) {
        if (edge.node.ruleSet) ids.add(edge.node.id);
      }

      hasNextPage = json.data?.collections?.pageInfo?.hasNextPage || false;
      cursor = json.data?.collections?.pageInfo?.endCursor || null;
    }

    autoIdsCache.set(shopDomain, { ids, at: Date.now() });
    return ids;
  } catch (e: any) {
    // Fail-open: sin filtrar (comportamiento anterior) y sin cachear el
    // fallo — el siguiente producto reintenta.
    console.error(`[Collections] Error obteniendo colecciones automáticas de ${shopDomain}:`, e?.message || e);
    return new Set<string>();
  }
}
