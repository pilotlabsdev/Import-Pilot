import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/lib/db.server";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const UPLOAD_DIR = path.join(os.tmpdir(), "importador-uploads");

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const url = new URL(request.url);
  const configId = url.searchParams.get("configId");
  const fileName = url.searchParams.get("file");

  if (!configId || !fileName) {
    return new Response("Parámetros requeridos", { status: 400 });
  }

  const config = await prisma.importConfig.findUnique({ where: { id: configId } });
  if (!config || config.shopDomain !== shopDomain) {
    return new Response("No encontrado", { status: 404 });
  }

  const filePath = path.join(UPLOAD_DIR, shopDomain, configId, fileName);

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(fileName).toLowerCase();

    const mimeTypes: Record<string, string> = {
      ".csv": "text/csv",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xls": "application/vnd.ms-excel",
      ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    };

    return new Response(content, {
      headers: {
        "Content-Type": mimeTypes[ext] || "application/octet-stream",
        "Content-Disposition": `inline; filename="${fileName}"`,
      },
    });
  } catch {
    return new Response("Archivo no encontrado", { status: 404 });
  }
};
