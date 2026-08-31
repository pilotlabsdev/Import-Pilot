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
        first: 50,
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
