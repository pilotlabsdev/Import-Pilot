/**
 * Aceptación de DOS client secrets durante la rotación de SHOPIFY_API_SECRET.
 *
 * Fundamento (docs oficiales Shopify, verificadas 2026-10-26):
 *  - "Manage your app credentials" paso 2: "Shopify signs webhooks with your
 *    app's oldest unrevoked client secret ... update your verification logic
 *    to accept signatures from both the old and new secret during the
 *    transition. Don't switch to validating with only the new secret until
 *    after you revoke the old one ... or you'll reject genuine webhooks."
 *  - "Verify webhook deliveries": "it can take up to an hour for the HMAC
 *    digest to be generated using the new secret."
 *
 * Shopify NO ofrece un "modo dual" — lo implementa la app. Aquí NO se relaja
 * la validación: una petición solo se acepta si su firma es VÁLIDA con al
 * menos uno de los dos secretos (si no, se rechaza como siempre). Lo único
 * que se hace cuando la firma es válida con el secret LEGACY pero la
 * librería validaría con el PRIMARIO es **re-firmar la petición entrante**
 * (HMAC de webhook / firma HS256 del session token) con el secret primario.
 * Al ser HMAC simétrico y haberse verificado antes con LEGACY, la re-firma
 * conserva exactamente el mismo significado y las mismas claims.
 *
 * SIN la variable SHOPIFY_API_SECRET_OLD (o si es igual al primario) TODAS
 * las funciones de este módulo devuelven la petición intacta: cero cambios
 * de comportamiento respecto a hoy.
 */

import crypto from "node:crypto";

const PRIMARY = (process.env.SHOPIFY_API_SECRET || "").trim();
const LEGACY = (process.env.SHOPIFY_API_SECRET_OLD || "").trim();

/** ¿Hay una rotación en curso (dos secretos distintos configurados)? */
export function hasLegacySecret(): boolean {
  return Boolean(PRIMARY && LEGACY && PRIMARY !== LEGACY);
}

function hmacB64(secret: string, data: string): string {
  return crypto.createHmac("sha256", secret).update(data, "utf8").digest("base64");
}

function hmacB64url(secret: string, data: string): string {
  return crypto.createHmac("sha256", secret).update(data, "utf8").digest("base64url");
}

/** Comparación en tiempo constante tolerando longitudes distintas (sin throw). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** HMAC en base64 comparado de forma segura (formato X-Shopify-Hmac-SHA256). */
function hmacMatches(secret: string, body: string, header: string): boolean {
  if (!secret || !header) return false;
  const calculated = hmacB64(secret, body);
  const a = Buffer.from(calculated, "base64");
  const b = Buffer.from(header, "base64");
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * ¿Es válida la firma de webhook con ALGÚNO de los secretos vigentes?
 * Se usa en el HMAC manual (webhooks compliance y app/uninstalled) y durante
 * la rotación acepta también el legacy — nunca uno que no sea de la lista.
 */
export function webhookHmacValid(body: string, header: string): boolean {
  if (hmacMatches(PRIMARY, body, header)) return true;
  if (hasLegacySecret() && hmacMatches(LEGACY, body, header)) return true;
  return false;
}

/**
 * Firma de webhook válida SOLO con el secret legacy (con el primario ya no
 * cuadra) → es el caso que la librería rechazaría y que hay que re-firmar.
 */
function webhookSignedWithLegacyOnly(body: string, header: string): boolean {
  if (!hasLegacySecret()) return false;
  if (hmacMatches(PRIMARY, body, header)) return false;
  return hmacMatches(LEGACY, body, header);
}

/**
 * Petición de webhook lista para ser entregada a authenticate.webhook():
 * - sin rotación → la MISMA petición, intacta.
 * - firma ya válida con el primario → la MISMA petición, intacta.
 * - firma válida solo con LEGACY → copia con X-Shopify-Hmac-SHA256 re-firmado
 *   con el primario (el body se reutiliza tal cual: es el que firmó Shopify).
 * - firma inválida con ambos → copia intacta, para que la librería responda
 *   401 exactamente como hoy (nunca se acepta algo que no venía de Shopify).
 *
 * NOTA: lee el body una sola vez. Fuera de rotación no se toca nada y la
 * lectura no ocurre, para no consumir el stream de la petición original.
 */
export async function prepareWebhookRequest(request: Request): Promise<Request> {
  if (!hasLegacySecret()) return request;

  const header = request.headers.get("X-Shopify-Hmac-SHA256") || "";
  const rawBody = await request.text();
  if (!webhookSignedWithLegacyOnly(rawBody, header)) {
    // Reconstruimos con el body ya leído: el original quedó consumido.
    return rebuildRequest(request, { body: rawBody });
  }

  const headers = new Headers(request.headers);
  headers.set("X-Shopify-Hmac-SHA256", hmacB64(PRIMARY, rawBody));
  console.info("[DualSecret] webhook re-firmado con el secret primario (firma previa válida con LEGACY)");
  return rebuildRequest(request, { body: rawBody, headers });
}

/** Reconstruye una Request preservando método/URL/body (necesario tras leer el body). */
function rebuildRequest(
  request: Request,
  opts: { body?: BodyInit | null; headers?: Headers; url?: string }
): Request {
  const init: RequestInit = {
    method: request.method,
    headers: opts.headers ?? request.headers,
    redirect: request.redirect,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = opts.body ?? null;
  }
  return new Request(opts.url ?? request.url, init);
}

/** Decodifica un segmento base64url a string UTF-8 (sin validar). */
function b64urlToString(seg: string): string {
  return Buffer.from(seg, "base64url").toString("utf8");
}

/** ¿Es una firma HS256 válida con `secret`? (claims NO se validan aquí). */
function jwtSignedWith(secret: string, token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(b64urlToString(parts[0]));
    if (header?.alg !== "HS256") return false; // solo simétrico: re-firmable
  } catch {
    return false;
  }
  const expected = hmacB64url(secret, `${parts[0]}.${parts[1]}`);
  return timingSafeEqualStr(expected, parts[2]);
}

/** Firma JWT válida solo con LEGACY (con el primario ya no cuadra). */
function jwtSignedWithLegacyOnly(token: string): boolean {
  if (!hasLegacySecret()) return false;
  if (jwtSignedWith(PRIMARY, token)) return false;
  return jwtSignedWith(LEGACY, token);
}

/** Re-firma el JWT con el secret primario conservando header y payload. */
function resignJwt(token: string): string {
  const parts = token.split(".");
  return `${parts[0]}.${parts[1]}.${hmacB64url(PRIMARY, `${parts[0]}.${parts[1]}`)}`;
}

/**
 * Petición lista para authenticate.admin(). La librería valida el session
 * token (id_token) con UN secret; durante la rotación Shopify puede firmarlo
 * con el legacy. Si la firma es válida solo con LEGACY, se re-emite el token
 * re-firmado con el primario (mismas claims: dest/aud/sub/exp… intactos).
 * - Sin rotación, sin token, o firma ya válida con el primario → intacta.
 * - Firma inválida con ambos → intacta (la librería responde 401 como hoy).
 */
export function prepareAdminRequest(request: Request): Request {
  if (!hasLegacySecret()) return request;

  // 1) Token en el header Authorization: Bearer <id_token>
  const auth = request.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token && jwtSignedWithLegacyOnly(token)) {
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${resignJwt(token)}`);
      console.info("[DualSecret] session token re-firmado con el secret primario (Authorization)");
      return rebuildRequest(request, { headers });
    }
    return request;
  }

  // 2) Token en la query string ?id_token=… (documento embebido)
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return request;
  }
  const token = url.searchParams.get("id_token");
  if (!token || !jwtSignedWithLegacyOnly(token)) return request;

  url.searchParams.set("id_token", resignJwt(token));
  console.info("[DualSecret] session token re-firmado con el secret primario (id_token)");
  return rebuildRequest(request, { url: url.toString() });
}
