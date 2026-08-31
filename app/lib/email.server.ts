const SENDGRID_API = "https://api.sendgrid.com/v3/mail/send";

interface SendEmailParams {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<boolean> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return false;

  try {
    const res = await fetch(SENDGRID_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: params.to }],
            subject: params.subject,
          },
        ],
        from: { email: params.from, name: "Import Pilot Soporte" },
        reply_to: params.replyTo ? { email: params.replyTo } : undefined,
        content: [
          {
            type: "text/plain",
            value: params.text,
          },
          ...(params.html
            ? [{ type: "text/html", value: params.html }]
            : []),
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[SendGrid] Error:", err);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[SendGrid] Error enviando email:", err);
    return false;
  }
}

export async function sendOfflineNotification(opts: {
  to: string;
  merchantEmail: string;
  shopDomain: string;
  message: string;
}): Promise<boolean> {
  const subject = `Nuevo mensaje de soporte - ${opts.shopDomain}`;
  const text = [
    `Hola,`,
    ``,
    `El merchant de ${opts.shopDomain} te ha enviado un mensaje:`,
    ``,
    `"${opts.message}"`,
    ``,
    `Responde desde Telegram o desde la app para que el merchant vea tu respuesta.`,
    ``,
    `— Import Pilot Soporte`,
  ].join("\n");

  return sendEmail({
    to: opts.to,
    from: process.env.SENDGRID_FROM_EMAIL || "pilotlabsdev@gmail.com",
    subject,
    text,
    replyTo: opts.merchantEmail,
  });
}
