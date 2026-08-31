# Chat Plan — Merchant ↔ Developer via Telegram Bot

## Arquitectura

```
Merchant (app Shopify)  →  Servidor (Render)  →  Telegram Bot API  →  Developer (Telegram móvil)
```

## Flujo

1. Merchant escribe mensaje en la app Shopify
2. Servidor guarda en tabla `SupportMessage` (Prisma/SQLite)
3. Servidor hace POST a Telegram Bot API (`sendMessage`)
4. Developer recibe push en Telegram (móvil)
5. Developer contesta desde Telegram
6. Servidor recibe respuesta via webhook (`/webhooks/telegram`)
7. Respuesta guardada en DB, merchant la ve en la app

## Prisma Schema

```prisma
model SupportMessage {
  id          String   @id @default(cuid())
  shopDomain  String
  sender      String   // "merchant" | "developer"
  message     String
  createdAt   DateTime @default(now())
  readAt      DateTime?
}
```

## API Endpoints

- `POST /api/support/message` — merchant envía mensaje
- `GET /api/support/messages?shop=...` — polling para nuevos mensajes (5-10s)
- `POST /webhooks/telegram` — recibe respuestas del developer desde Telegram

## Telegram Bot Setup

1. Crear bot via `@BotFather` en Telegram → obtener `BOT_TOKEN`
2. Configurar webhook: `https://api.yourdomain.com/webhooks/telegram`
3. Guardar `CHAT_ID` del developer (el chat privado con el bot)
4. Variables de entorno: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

## Librería npm (opcional)

- `teleping` — fire-and-forget notifications (más simple)
- `node-telegram-bot-api` — bidireccional completo

## Notificaciones por email (Resend)

- Cuando el merchant envía mensaje → email al developer
- Resend free tier: 3,000 emails/mes
- Reply-to apunta al servidor para interceptar respuestas

## UI en la App

- Página `/app.support` — chat con historial + input
- Badge en NavMenu con mensajes sin leer
- polling cada 5-10s para nuevos mensajes
