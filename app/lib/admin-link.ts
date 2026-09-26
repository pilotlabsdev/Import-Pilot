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

export function buildAdminAppUrl(shop: string | null | undefined): string {
  const store = storeHandleFromShop(shop);
  return store ? `${ADMIN_ORIGIN}/store/${store}/apps/${APP_HANDLE}` : ADMIN_ORIGIN;
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
