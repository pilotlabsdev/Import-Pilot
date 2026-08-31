import type { ActionFunctionArgs } from "react-router";
import { prisma } from "~/lib/db.server";
import { sendTelegramMessage } from "~/lib/telegram.server";

// POST: recibe mensajes del developer desde Telegram
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const body = await request.json();

    const msg = body.message;
    if (!msg || !msg.text) {
      return new Response("ok", { status: 200 });
    }

    const chatId = String(msg.chat.id);
    const expectedChatId = process.env.TELEGRAM_CHAT_ID;

    if (expectedChatId && chatId !== expectedChatId) {
      return new Response("ok", { status: 200 });
    }

    const text = msg.text.trim();

    // Comandos del developer
    if (text === "/online") {
      await prisma.devStatus.upsert({
        where: { id: "singleton" },
        update: { isOnline: true, lastPingAt: new Date() },
        create: { id: "singleton", isOnline: true, lastPingAt: new Date() },
      });
      await sendTelegramMessage("✅ Ahora estás ONLINE. Los merchants verán tu estado.");
      return new Response("ok", { status: 200 });
    }

    if (text === "/offline") {
      await prisma.devStatus.upsert({
        where: { id: "singleton" },
        update: { isOnline: false },
        create: { id: "singleton", isOnline: false },
      });
      await sendTelegramMessage("🔴 Ahora estás OFFLINE. Los merchants verán que no estás disponible.");
      return new Response("ok", { status: 200 });
    }

    if (text === "/status") {
      const status = await prisma.devStatus.findUnique({ where: { id: "singleton" } });
      const isOnline = status?.isOnline ?? false;
      await sendTelegramMessage(isOnline ? "🟢 Estado actual: ONLINE" : "🔴 Estado actual: OFFLINE");
      return new Response("ok", { status: 200 });
    }

    if (text.startsWith("/")) {
      return new Response("ok", { status: 200 });
    }

    // Mensaje normal del developer → guardarlo como respuesta + mantener online
    const lastMerchantMsg = await prisma.supportMessage.findFirst({
      where: { sender: "merchant" },
      orderBy: { createdAt: "desc" },
    });

    const shopDomain = lastMerchantMsg?.shopDomain || "unknown";

    await prisma.$transaction([
      prisma.supportMessage.create({
        data: {
          shopDomain,
          sender: "developer",
          message: text,
        },
      }),
      prisma.devStatus.upsert({
        where: { id: "singleton" },
        update: { lastPingAt: new Date(), isOnline: true },
        create: { id: "singleton", lastPingAt: new Date(), isOnline: true },
      }),
    ]);

    console.log(`[Telegram] Respuesta del dev guardada para ${shopDomain}`);
  } catch (err) {
    console.error("[Telegram] Error procesando webhook:", err);
  }

  return new Response("ok", { status: 200 });
};
