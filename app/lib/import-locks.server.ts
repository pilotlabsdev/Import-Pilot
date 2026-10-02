const activeImports = new Map<string, AbortController>();

export function tryAcquireImport(configId: string): AbortController | null {
  if (activeImports.has(configId)) return null;
  const controller = new AbortController();
  activeImports.set(configId, controller);
  return controller;
}

export function releaseImport(configId: string) {
  activeImports.delete(configId);
}

export function abortImport(configId: string): boolean {
  const controller = activeImports.get(configId);
  if (controller) {
    controller.abort();
    return true;
  }
  return false;
}

export function isImportActive(configId: string): boolean {
  return activeImports.has(configId);
}

export function getActiveImportCount(): number {
  return activeImports.size;
}

// Límite global de imports en vuelo (chunks en marcha + fase activa de bulk).
// Protege BD/pool y memoria cuando N merchants encolan a la vez. Las items
// que no caben quedan "queued": las recoge el sweep del scheduler (60s) o el
// processNext que se dispara al terminar cada import manual.
const MAX_ACTIVE_IMPORTS = Math.max(1, Number(process.env.MAX_ACTIVE_IMPORTS) || 10);

export function canStartImport(): boolean {
  return activeImports.size < MAX_ACTIVE_IMPORTS;
}

export function maxActiveImports(): number {
  return MAX_ACTIVE_IMPORTS;
}

// --- Rate limiter for Shopify API (cost-based) ---
// Doc oficial (shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits):
// - Bucket de PUNTOS por app+tienda (leaky bucket): Standard=100 pts/s,
//   Advanced=200, Plus=1000. El refill/capacidad reales los dicta Shopify.
// - Coste: Mutation=10, Connection=tamaño de first/last, Scalar/Enum=0, Object=1;
//   límite de una sola query = 1000 pts.
// - Cada respuesta incluye extensions.cost.throttleStatus
//   {maximumAvailable, currentlyAvailable, restoreRate} → sincronizamos NUESTRO
//   bucket con el de Shopify en cada respuesta (fuente de verdad; Shopify también
//   reembolsa requested-actual al terminar la query).
// - Reservamos un coste ESTIMADO antes de enviar (regula la concurrencia interna);
//   la sincronización posterior corrige con el estado real.
// - El reintento de THROTTLED con backoff (más abajo) sigue siendo la red de seguridad.
// Calls sin shop conocido (p.ej. webhooks sin contexto) caen al bucket "global".

const DEFAULT_RESTORE_PTS = 100;   // Standard (doc); la 1ª respuesta lo corrige
const DEFAULT_CAPACITY_PTS = 1000; // maximumAvailable típico; la 1ª respuesta lo corrige

type PtBucket = { points: number; capacity: number; restoreRate: number; lastRefill: number };
const ptBuckets = new Map<string, PtBucket>();

function getPtBucket(key: string): PtBucket {
  let b = ptBuckets.get(key);
  if (!b) {
    b = { points: DEFAULT_CAPACITY_PTS, capacity: DEFAULT_CAPACITY_PTS, restoreRate: DEFAULT_RESTORE_PTS, lastRefill: Date.now() };
    ptBuckets.set(key, b);
  }
  return b;
}

function refillPts(b: PtBucket): void {
  const now = Date.now();
  const elapsed = (now - b.lastRefill) / 1000;
  if (elapsed > 0) {
    // A4: clamp ≥0 — el bucket nunca acumula deuda negativa
    b.points = Math.min(b.capacity, Math.max(0, b.points + elapsed * b.restoreRate));
    b.lastRefill = now;
  }
}

/** Sincroniza con extensions.cost.throttleStatus (doc oficial). */
function syncPtBucketFromCost(key: string, cost: any): void {
  const ts = cost?.throttleStatus;
  if (!ts || typeof ts.currentlyAvailable !== "number") return;
  const b = getPtBucket(key);
  if (typeof ts.maximumAvailable === "number" && ts.maximumAvailable > 0) b.capacity = ts.maximumAvailable;
  if (typeof ts.restoreRate === "number" && ts.restoreRate > 0) b.restoreRate = ts.restoreRate;
  b.points = Math.min(b.capacity, Math.max(0, ts.currentlyAvailable));
  b.lastRefill = Date.now();
}

/** Coste estimado pre-envío (doc: Mutation=10, Connection=first/last, raíz ~1). */
function estimateCostPts(query: string): number {
  let pts = 0;
  for (const m of query.matchAll(/\b(?:first|last)\s*:\s*(\d+)/g)) pts += Number(m[1]) || 0;
  pts += /\bmutation\b/.test(query) ? 10 : 1;
  return Math.max(1, Math.min(pts, 1000));
}

function waitForCost(shopKey: string, estimatedPts: number): Promise<void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      const b = getPtBucket(shopKey);
      refillPts(b);
      if (b.points >= estimatedPts) {
        b.points -= estimatedPts;
        resolve();
        return;
      }
      // Re-check en bucle (patrón A4): solo resta con puntos suficientes →
      // deuda negativa imposible; espera máx 1000ms por vuelta y re-evalúa.
      const waitMs = Math.ceil((estimatedPts - b.points) / b.restoreRate * 1000);
      setTimeout(tryAcquire, Math.min(Math.max(waitMs, 25), 1000));
    };
    tryAcquire();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function rateLimitedGraphql(
  admin: any,
  query: string,
  vars: any,
  maxRetries = 3,
  // A4: reintento del mismo request lógico (p.ej. tras refresh de token 401)
  // → no cobra puntos del bucket. Los reintentos internos de abajo ya eran
  // gratis (el coste se reserva una sola vez antes del bucle).
  isRetry = false,
  // Bucket por tienda: clave = shopDomain; sin clave → bucket "global".
  shopKey?: string
): Promise<any> {
  if (!isRetry) await waitForCost(shopKey || "global", estimateCostPts(query));
  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await admin.graphql(query, { variables: vars });
        let json: any;
        try {
          json = await res.json();
        } catch (parseError: any) {
          if (attempt < maxRetries) {
            const wait = attempt * 3000;
            console.warn(`[RateLimit] JSON parse failed (attempt ${attempt}/${maxRetries}): ${parseError?.message}. Retrying in ${wait}ms...`);
            await sleep(wait);
            continue;
          }
          throw new Error(`Shopify API returned invalid JSON after ${maxRetries} attempts: ${parseError?.message}`);
        }
        // Sync con el bucket real de Shopify (throttleStatus de esta respuesta)
        syncPtBucketFromCost(shopKey || "global", json.extensions?.cost);
        const gqlErrors = json.errors || [];
        const isThrottled = gqlErrors.some((e: any) =>
          e.message?.includes("Throttled") ||
          e.message?.includes("THROTTLED") ||
          e.extensions?.code === "THROTTLED" ||
          e.extensions?.code === "too_many_requests"
        );
        if (isThrottled && attempt < maxRetries) {
          const wait = attempt * 2000;
          await sleep(wait);
          continue;
        }
        const isUnauthorized = gqlErrors.some((e: any) =>
          e.message?.includes("Unauthorized") ||
          e.message?.includes("401") ||
          e.extensions?.code === "UNAUTHORIZED"
        );
        if (isUnauthorized && attempt < maxRetries) {
          const wait = attempt * 3000;
          await sleep(wait);
          continue;
        }
        if (isUnauthorized) {
          throw new Error(`Unauthorized: ${JSON.stringify(gqlErrors)}`);
        }
        return json;
      } catch (error: any) {
        const msg = String(error?.message || error?.toString() || "").toLowerCase();
        const statusCode = Number(error?.response?.status || error?.status || 0);
        const isThrottled = statusCode === 429 ||
          msg.includes("throttled") ||
          msg.includes("too_many_requests") ||
          msg.includes("rate limit");
        if (isThrottled && attempt < maxRetries) {
          const wait = attempt * 2000;
          await sleep(wait);
          continue;
        }
        const isUnauthorized = statusCode === 401 ||
          msg.includes("unauthorized") ||
          msg.includes("session not found") ||
          msg.includes("invalid_token");
        if (isUnauthorized && attempt < maxRetries) {
          const wait = attempt * 3000;
          await sleep(wait);
          continue;
        }
        throw error;
      }
    }
  } finally {
    // No release needed — points bucket is time-based, not counting-based
  }
}
