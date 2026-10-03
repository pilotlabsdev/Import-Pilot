import { Navigate, useLocation, useMatches } from "react-router";

export default function SupplierIndex() {
  const matches = useMatches();
  const location = useLocation();
  const supplierMatch = matches.find((m) => m.id?.includes("supplier.$id"));
  const id = supplierMatch?.params?.id as string | undefined;

  if (!id) return null;

  return (
    <Navigate
      to={{ pathname: `/app/supplier/${id}/import`, search: location.search }}
      replace
    />
  );
}
