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

// appPath: ruta de la app (ej. "/app/supplier/x/logs"). El admin la abre dentro
// del iframe — mismo formato espejado que la barra de direcciones del admin
// (".../apps/import-pilot-official/app/duplicates") y las admin link extensions.
export function buildAdminAppUrl(shop: string | null | undefined, appPath?: string | null): string {
  const store = storeHandleFromShop(shop);
  if (!store) return ADMIN_ORIGIN;
  const path = appPath && appPath.startsWith("/") ? appPath : "";
  return `${ADMIN_ORIGIN}/store/${store}/apps/${APP_HANDLE}${path}`;
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
