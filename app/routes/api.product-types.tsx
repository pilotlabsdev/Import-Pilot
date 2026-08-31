import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  try {
    const res = await admin.graphql(
      `#graphql
      query {
        productTypes(first: 1000) {
          edges {
            node
          }
        }
      }`
    );
    const json: any = await res.json();
    const types = (json.data?.productTypes?.edges || []).map((e: any) => e.node).filter(Boolean);
    return data({ productTypes: types });
  } catch (e: any) {
    console.error("[ProductTypes] Error:", e?.message);
    return data({ productTypes: [] });
  }
};
