import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/lib/db.server";
import { sendTelegramMessage } from "~/lib/telegram.server";

// GET: obtener mensajes + estado del dev
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const after = url.searchParams.get("after");

  const where: any = { shopDomain };
  if (after) {
    where.createdAt = { gt: new Date(after) };
  }

  const [messages, devStatus] = await Promise.all([
    prisma.supportMessage.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
    prisma.devStatus.findUnique({ where: { id: "singleton" } }),
  ]);

  const isOnline = devStatus
    ? Date.now() - devStatus.lastPingAt.getTime() < 120_000 // 2 min
    : false;

  return data({ messages, isOnline });
};

// POST: enviar mensaje del merchant
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const form = await request.formData();
  const message = (form.get("message") as string)?.trim();
  const email = (form.get("email") as string)?.trim() || null;

  if (!message) return data({ error: "Mensaje requerido" }, { status: 400 });

  // Guardar en DB
  const saved = await prisma.supportMessage.create({
    data: {
      shopDomain,
      sender: "merchant",
      message,
      email,
    },
  });

  // Enviar a Telegram
  const telegramText = [
    `<b>Nuevo mensaje de soporte</b>`,
    `<b>Tienda:</b> ${shopDomain}`,
    email ? `<b>Email:</b> ${email}` : null,
    ``,
    message,
  ]
    .filter(Boolean)
    .join("\n");

  await sendTelegramMessage(telegramText);

  return data({ success: true, message: saved });
};
