const TELEGRAM_API = "https://api.telegram.org/bot";

function getToken() {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

function getChatId() {
  return process.env.TELEGRAM_CHAT_ID || "";
}

export async function sendTelegramMessage(text: string): Promise<boolean> {
  const token = getToken();
  const chatId = getChatId();
  if (!token || !chatId) return false;

  try {
    const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("[Telegram] Error enviando mensaje:", err);
    return false;
  }
}

export async function setTelegramWebhook(webhookUrl: string): Promise<boolean> {
  const token = getToken();
  if (!token) return false;

  try {
    const res = await fetch(`${TELEGRAM_API}${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await res.json();
    console.log("[Telegram] Webhook setup:", data);
    return data.ok === true;
  } catch (err) {
    console.error("[Telegram] Error configurando webhook:", err);
    return false;
  }
}
