import { Navigate, useMatches } from "react-router";

export default function SupplierIndex() {
  const matches = useMatches();
  const supplierMatch = matches.find((m) => m.id?.includes("supplier.$id"));
  const id = supplierMatch?.params?.id as string | undefined;

  if (!id) return null;

  return <Navigate to={`/app/supplier/${id}/import`} replace />;
}
