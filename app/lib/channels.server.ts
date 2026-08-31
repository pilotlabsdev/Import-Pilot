export interface SalesChannel {
  id: string;
  name: string;
  handle: string;
}

export interface Market {
  id: string;
  name: string;
  handle: string;
  status: string;
  publicationId: string | null;
}

async function fetchAllPublications(admin: any): Promise<Array<{ id: string; name: string }>> {
  const response = await admin.graphql(`
    #graphql
    query AllPublications {
      publications(first: 50) {
        nodes {
          id
          name
        }
      }
    }
  `);
  const json = await response.json();
  return json.data?.publications?.nodes || [];
}

export async function getChannels(admin: any): Promise<SalesChannel[]> {
  const pubs = await fetchAllPublications(admin);
  const marketPubIds = await getMarketPublicationIds(admin);

  return pubs
    .filter((p) => !marketPubIds.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name || "Canal",
      handle: "",
    }));
}

async function getMarketPublicationIds(admin: any): Promise<Set<string>> {
  const response = await admin.graphql(`
    #graphql
    query MarketPubs {
      markets(first: 50) {
        nodes {
          name
          catalogs(first: 5) {
            nodes {
              publication { id }
            }
          }
        }
      }
    }
  `);
  const json = await response.json();
  const markets = json.data?.markets?.nodes || [];
  const ids = new Set<string>();
  for (const m of markets) {
    for (const cat of m.catalogs?.nodes || []) {
      if (cat.publication?.id) ids.add(cat.publication.id);
    }
  }
  return ids;
}

export async function getMarkets(admin: any): Promise<Market[]> {
  const pubs = await fetchAllPublications(admin);
  const pubsByName = new Map<string, string>();
  for (const p of pubs) {
    if (p.name) pubsByName.set(p.name.toLowerCase(), p.id);
  }

  const response = await admin.graphql(`
    #graphql
    query Markets {
      markets(first: 50) {
        nodes {
          id
          name
          handle
          status
          catalogs(first: 5) {
            nodes {
              id
              title
              publication {
                id
              }
            }
          }
        }
      }
    }
  `);
  const json = await response.json();
  const markets = json.data?.markets?.nodes || [];
  return markets.map((m: any) => {
    let publicationId = m.catalogs?.nodes?.[0]?.publication?.id ?? null;
    if (!publicationId && m.name) {
      publicationId = pubsByName.get(m.name.toLowerCase()) ?? null;
    }
    return {
      id: m.id,
      name: m.name,
      handle: m.handle,
      status: m.status,
      publicationId,
    };
  });
}
