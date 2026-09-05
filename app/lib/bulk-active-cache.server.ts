// In-memory cache to track shops with active bulk imports
// Avoids 1300+ DB queries per webhook flood during bulk operations
// Auto-expires after 2h as safety net if clearBulkActive is never called

const activeBulkCache = new Map<string, number>();

const AUTO_EXPIRE_MS = 2 * 60 * 60 * 1000; // 2 hours

export function setBulkActive(shop: string): void {
  activeBulkCache.set(shop, Date.now());
}

export function clearBulkActive(shop: string): void {
  activeBulkCache.delete(shop);
}

export function isBulkActive(shop: string): boolean {
  const ts = activeBulkCache.get(shop);
  if (!ts) return false;
  if (Date.now() - ts > AUTO_EXPIRE_MS) {
    activeBulkCache.delete(shop);
    return false;
  }
  return true;
}
