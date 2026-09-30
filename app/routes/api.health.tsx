import type { LoaderFunctionArgs } from "react-router";

export const loader = (_args: LoaderFunctionArgs) =>
  Response.json({
    ok: true,
    time: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
