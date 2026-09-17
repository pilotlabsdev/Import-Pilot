import { useState, useEffect } from "react";

export function HydratedDate({ dateString, format }: { dateString: string | Date; format?: "datetime" | "date" | "time" }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  if (!hydrated) return <span>{"\u2014"}</span>;

  const d = new Date(dateString);
  if (format === "date") return <span>{d.toLocaleDateString("es-ES")}</span>;
  if (format === "time") return <span>{d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}</span>;
  return <span>{d.toLocaleString("es-ES")}</span>;
}
