// Deep-links a Shopify admin — usados por el loader de /app (server) y por
// AppBridgeBounce (client) cuando una URL llega sin parámetros `shop`.
export const APP_HANDLE = "import-pilot-official";
export const ADMIN_ORIGIN = "https://admin.shopify.com";
export const SHOP_COOKIE = "ip_last_shop";

export function storeHandleFromShop(shop: string | null | undefined): string | null {
  if (!shop) return null;
  const s = shop.trim().toLowerCase();
  if (!s.endsWith(".myshopify.com")) return null;
  const handle = s.slice(0, -".myshopify.com".length);
  return handle || null;
}

// appPath: ruta de la app (ej. "/app/supplier/x/logs") — se pasa desde la URL
// de la petición, sin hardcodear. Formatos verificados en navegador:
// - Con tienda:  admin.shopify.com/store/{tienda}/apps/{handle}{ruta}
// - Sin tienda:  admin.shopify.com/apps/{handle}{ruta}  (link universal — el
//   admin resuelve la tienda activa de la sesión; nunca la home de admin).
// Ojo con las cookies: ip_last_shop se crea en el iframe y los navegadores la
// particionan (3rd-party) → casi nunca llega top-level, por eso el universal
// es el fallback normal.
export function buildAdminAppUrl(shop: string | null | undefined, appPath?: string | null): string {
  const path = appPath && appPath.startsWith("/") ? appPath : "";
  const store = storeHandleFromShop(shop);
  if (store) return `${ADMIN_ORIGIN}/store/${store}/apps/${APP_HANDLE}${path}`;
  return `${ADMIN_ORIGIN}/apps/${APP_HANDLE}${path}`;
}

// Página de planes alojada de Shopify App Pricing (Shopify la sirve; misma
// ruta que el campo "Redirect URL" de los planes en el Partner Dashboard).
// Se usa con target="_top" desde el iframe: no existe en nuestra app.
export function buildPlansUrl(shop: string | null | undefined): string {
  const store = storeHandleFromShop(shop);
  if (store) return `${ADMIN_ORIGIN}/store/${store}/charges/${APP_HANDLE}/pricing_plans`;
  return `${ADMIN_ORIGIN}/apps/${APP_HANDLE}`;
}

export function shopFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)ip_last_shop=([^;]*)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]) || null;
  } catch {
    return null;
  }
}

// Contexto volatile guardado en sessionStorage del navegador (por pestaña),
// NO en la BD. Lo escribe app.tsx mientras la URL trae `shop` y lo lee
// AppBridgeBounce si una recarga deja el documento sin params (deploy,
// F5, navegación SPA que borra la query).
export const CTX_KEY = "ip_ctx";
export const CTX_RETRY_KEY = "ip_ctx_last_try";

export function readStoredShop(): string | null {
  try {
    return new URLSearchParams(sessionStorage.getItem(CTX_KEY) || "").get("shop");
  } catch {
    return null;
  }
}
