// Colecciones de la tienda, con distinción manual vs automática.
//
// Filtro OFICIAL (docs 2026-07, argumento `query` de la query collections):
//   collection_type:custom  -> colecciones manuales
//   collection_type:smart   -> colecciones automáticas (con reglas)
// Validado con test solo-lectura 2026-10-20 contra hifimediastore: equivalencia
// EXACTA con el marcador ruleSet==null / ruleSet!=null (254 col = 166 custom +
// 88 smart, 0 solape, 0 tipos fuera). Se evita el campo `ruleSet` porque está
// DEPRECADO en 2026-07 (sustituir por el filtro oficial evita romperse en
// futuras versiones de la API).
//
// IMPORTANTE (tests A-E 2026-10-20 sobre colecciones smart en price-pilot):
// - collectionAddProducts / collectionRemoveProducts sobre smart se aceptan
//   en silencio pero NO hacen nada (no-op; miembro real permanece). Sustituto
//   oficial de ambas: `collectionUpdate` con
//   collection.sourcesToUpdate[].condition.inclusion.selectionsToAdd /
//   .selectionsToRemove (mutaciones deprecated; migración pendiente y solo
//   aplica a colecciones manuales, porque la app excluye las automáticas).
// - productSet(collections: [...]) al crear SÍ fuerza una membresía manual,
//   contaminando la colección con productos que no cumplen sus reglas.
// Por eso el motor de importación y el picker de mapeo EXCLUYEN las smart.

const AUTO_COLLECTIONS_TTL_MS = 10 * 60 * 1000; // 10 min
const autoIdsCache = new Map<string, { ids: Set<string>; at: number }>();
const sourceIdCache = new Map<string, { id: string | null; at: number }>();

/**
 * Colecciones MANUALES de la tienda (para el picker de mapeo de categorías).
 * Solo `collection_type:custom`; las automáticas (smart) no se muestran.
 */
export async function getCollections(admin: any): Promise<Array<{ id: string; title: string }>> {
  const collections: Array<{ id: string; title: string }> = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const query = `#graphql
      query($first: Int!, $after: String, $q: String) {
        collections(first: $first, after: $after, query: $q) {
          edges {
            node {
              id
              title
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
        q: "collection_type:custom",
        ...(cursor ? { after: cursor } : {}),
      },
    });

    const json = await response.json();
    const edges = json.data?.collections?.edges || [];

    for (const edge of edges) {
      collections.push({ id: edge.node.id, title: edge.node.title });
    }

    hasNextPage = json.data?.collections?.pageInfo?.hasNextPage || false;
    cursor = json.data?.collections?.pageInfo?.endCursor || null;
  }

  return collections;
}

/**
 * IDs de colecciones AUTOMÁTICAS (collection_type:smart) de la tienda, con
 * caché de 10 minutos por tienda. El motor de importación las filtra para no
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
      query($first: Int!, $after: String, $q: String) {
        collections(first: $first, after: $after, query: $q) {
          edges {
            node {
              id
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
          q: "collection_type:smart",
          ...(cursor ? { after: cursor } : {}),
        },
      });

      const json = await response.json();
      // GraphQL parcial (rate-limit, etc.): fallar en vez de cachear vacío
      if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
      const edges = json.data?.collections?.edges || [];

      for (const edge of edges) {
        ids.add(edge.node.id);
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

/**
 * ID de la fuente conditions de una colección (CollectionConditionsSource),
 * necesaria para `collectionUpdate` con
 * `sourcesToUpdate[].condition.inclusion.selectionsToAdd / selectionsToRemove`
 * = sustituto OFICIAL de las mutaciones DEPRECATED collectionAddProducts /
 * collectionRemoveProducts (docs 2026-07; test 2026-10-20 sobre colección
 * manual: apply inmediato + idempotente,0 userErrors).
 *
 * Caché 10 min por tienda+colección. Devuelve null si la colección no tiene
 * fuente conditions (el llamante OMITE la operación y lo loguea) o si hay
 * error transitorio (fail-open sin cachear el fallo).
 */
export async function getCollectionConditionsSourceId(
  admin: any,
  collectionId: string,
  shopDomain: string
): Promise<string | null> {
  const key = `${shopDomain}|${collectionId}`;
  const hit = sourceIdCache.get(key);
  if (hit && Date.now() - hit.at < AUTO_COLLECTIONS_TTL_MS) return hit.id;

  try {
    const query = `#graphql
      query($id: ID!) {
        collection(id: $id) {
          sources {
            __typename
            id
          }
        }
      }`;
    const response: any = await admin.graphql(query, { variables: { id: collectionId } });
    const json = await response.json();
    if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
    const sources: any[] = json.data?.collection?.sources || [];
    const cond = sources.find((s) => s.__typename === "CollectionConditionsSource");
    const id: string | null = cond?.id || null;
    sourceIdCache.set(key, { id, at: Date.now() });
    return id;
  } catch (e: any) {
    console.error(`[Collections] Error leyendo sources de ${collectionId} (${shopDomain}):`, e?.message || e);
    return null;
  }
}
