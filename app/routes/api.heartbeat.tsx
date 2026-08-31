import type { ActionFunctionArgs } from "react-router";
import { prisma } from "~/lib/db.server";

// POST: developer hace ping para mantenerse online
export const action = async ({ request }: ActionFunctionArgs) => {
  // Verificar token simple para seguridad
  const form = await request.formData();
  const token = form.get("token");
  if (token !== process.env.TELEGRAM_BOT_TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  await prisma.devStatus.upsert({
    where: { id: "singleton" },
    update: { lastPingAt: new Date(), isOnline: true },
    create: { id: "singleton", lastPingAt: new Date(), isOnline: true },
  });

  return new Response("ok", { status: 200 });
};

// GET: consultar estado del dev
export const loader = async () => {
  const status = await prisma.devStatus.findUnique({
    where: { id: "singleton" },
  });

  const isOnline = status
    ? Date.now() - status.lastPingAt.getTime() < 120_000
    : false;

  return Response.json({ isOnline, lastPingAt: status?.lastPingAt });
};
