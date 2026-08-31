import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data, useLoaderData, useFetcher, useRevalidator } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Badge,
  Box,
} from "@shopify/polaris";
import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { authenticate } from "~/shopify.server";
import { prisma } from "~/lib/db.server";
import { sendTelegramMessage } from "~/lib/telegram.server";
import { sendOfflineNotification } from "~/lib/email.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const [messages, devStatus, existingSession] = await Promise.all([
    prisma.supportMessage.findMany({
      where: { shopDomain },
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
    prisma.devStatus.findUnique({ where: { id: "singleton" } }),
    prisma.supportMessage.findFirst({
      where: { shopDomain, sender: "merchant" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const isOnline = devStatus?.isOnline ?? false;

  const savedEmail = existingSession?.email || null;

  return data({ messages, isOnline, savedEmail });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const form = await request.formData();
  const message = (form.get("message") as string)?.trim();
  const email = (form.get("email") as string)?.trim() || null;

  if (!message) return data({ error: "Mensaje requerido" }, { status: 400 });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return data({ error: "Email válido requerido" }, { status: 400 });
  }

  const saved = await prisma.supportMessage.create({
    data: {
      shopDomain,
      sender: "merchant",
      message,
      email,
    },
  });

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

  const devStatus = await prisma.devStatus.findUnique({ where: { id: "singleton" } });
  if (!devStatus?.isOnline && email) {
    await sendOfflineNotification({
      to: process.env.SENDGRID_FROM_EMAIL || "pilotlabsdev@gmail.com",
      merchantEmail: email,
      shopDomain,
      message,
    });
  }

  return data({ success: true });
};

export default function SupportChat() {
  const { messages, isOnline, savedEmail } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const { revalidate } = useRevalidator();
  const [input, setInput] = useState("");
  const [email, setEmail] = useState(savedEmail || "");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const interval = setInterval(() => {
      revalidate();
    }, 5000);
    return () => clearInterval(interval);
  }, [revalidate]);

  const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

  const handleSend = useCallback(() => {
    if (!input.trim() || !isValidEmail(email)) return;
    const fd = new FormData();
    fd.set("message", input.trim());
    fd.set("email", email.trim());
    fetcher.submit(fd, { method: "POST" });
    setInput("");
  }, [input, email, fetcher]);

  return (
    <Page title={t("tutorialSupport.title")}>
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <div style={{ display: "flex", flexDirection: "column", height: "500px" }}>
              <div
                style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--p-color-border-secondary)",
                  backgroundColor: "var(--p-color-bg-surface)",
                }}
              >
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingSm" as="h3">
                    {t("tutorialSupport.chatOnline")}
                  </Text>
                  <Badge tone={isOnline ? "success" : "attention"}>
                    {isOnline ? t("tutorialSupport.online") : t("tutorialSupport.offline")}
                  </Badge>
                </InlineStack>
                {!isOnline && (
                  <Text variant="bodySm" tone="subdued" as="p">
                    {t("tutorialSupport.emailResponse")}
                  </Text>
                )}
              </div>

              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                {messages.length === 0 && (
                  <div style={{ textAlign: "center", padding: "40px 0" }}>
                    <Text variant="bodyMd" tone="subdued" as="p">
                      {t("tutorialSupport.chatGreeting")}
                    </Text>
                  </div>
                )}
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    style={{
                      display: "flex",
                      justifyContent:
                        msg.sender === "merchant" ? "flex-end" : "flex-start",
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "75%",
                        padding: "10px 14px",
                        borderRadius: "12px",
                        backgroundColor:
                          msg.sender === "merchant"
                            ? "var(--p-color-bg-surface-brand)"
                            : "var(--p-color-bg-surface)",
                        color:
                          msg.sender === "merchant"
                            ? "var(--p-color-text-on-color)"
                            : "var(--p-color-text)",
                      }}
                    >
                      <Text variant="bodyMd" as="p">
                        {msg.message}
                      </Text>
                      <Text variant="bodySm" as="p" tone="subdued">
                        {new Date(msg.createdAt).toLocaleTimeString("es-ES", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Text>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              <div
                style={{
                  padding: "12px 16px",
                  borderTop: "1px solid var(--p-color-border-secondary)",
                }}
              >
                <Box paddingBlockEnd="200">
                  <TextField
                    label={t("tutorialSupport.emailLabel")}
                    labelHidden
                    value={email}
                    onChange={setEmail}
                    type="email"
                    placeholder={t("tutorialSupport.emailRequired")}
                    autoComplete="email"
                  />
                </Box>
                <InlineStack gap="200" blockAlign="end">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label={t("tutorialSupport.messageLabel")}
                      labelHidden
                      value={input}
                      onChange={setInput}
                      placeholder={t("tutorialSupport.messagePlaceholder")}
                      autoComplete="off"
                    />
                  </div>
                  <Button
                    variant="primary"
                    onClick={handleSend}
                    disabled={!input.trim() || !isValidEmail(email)}
                  >
                    {t("tutorialSupport.send")}
                  </Button>
                </InlineStack>
              </div>
            </div>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
