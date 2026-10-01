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

// --- Rate limiter for Shopify API ---
// Bucket POR TIENDA: Shopify aplica los límites de rate per store, así que
// cada shopDomain tiene su propio bucket de 5 tokens/s (burst 10). Calls sin
// shop conocido (p.ej. webhooks sin contexto) caen al bucket "global".
// Shopify cost-based throttling: queries = 1pt, mutations = 10pt.
// A 5 req/s por tienda nos mantenemos bien bajo el límite ~50 req/s de cada tienda.

const TOKENS_PER_SECOND = 5;
const MAX_BURST = 10;

type Bucket = { tokens: number; lastRefill: number };
const buckets = new Map<string, Bucket>();

function getBucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: MAX_BURST, lastRefill: Date.now() };
    buckets.set(key, b);
  }
  return b;
}

function refillTokens(b: Bucket): void {
  const now = Date.now();
  const elapsed = (now - b.lastRefill) / 1000;
  if (elapsed > 0) {
    // A4: clamp ≥0 — el bucket nunca acumula deuda negativa
    b.tokens = Math.min(MAX_BURST, Math.max(0, b.tokens + elapsed * TOKENS_PER_SECOND));
    b.lastRefill = now;
  }
}

function waitForToken(shopKey: string): Promise<void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      const b = getBucket(shopKey);
      refillTokens(b);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        resolve();
        return;
      }
      // A4: re-check en bucle en vez de dormir una vez y restar "a ciegas".
      // Antes N esperadores simultáneos calculaban la misma espera y todos
      // hacían tokens -= 1 al despertar → deuda negativa y esperas de ~100s.
      // Ahora solo se resta con tokens >= 1 (deuda imposible) y, con tokens
      // >= 0, la espera máxima por vuelta es 200ms → la cola se re-evalúa
      // constantemente y se distribuye a ritmo de 5 tokens/s del bucket.
      const waitMs = Math.ceil((1 - b.tokens) / TOKENS_PER_SECOND * 1000);
      setTimeout(tryAcquire, Math.min(Math.max(waitMs, 20), 1000));
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
  // → no cobra token del bucket. Los reintentos internos de abajo ya eran
  // gratis (el token se cobra una sola vez antes del bucle).
  isRetry = false,
  // Bucket por tienda: clave = shopDomain; sin clave → bucket "global".
  shopKey?: string
): Promise<any> {
  if (!isRetry) await waitForToken(shopKey || "global");
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
    // No release needed — token bucket is time-based, not counting-based
  }
}
