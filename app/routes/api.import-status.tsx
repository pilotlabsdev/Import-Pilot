import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { isImportActive } from "~/lib/import-locks.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const configId = url.searchParams.get("configId") || "";

  if (!configId) {
    return data({ error: "Falta configId" }, { status: 400 });
  }

  return data({ active: isImportActive(configId) });
};
