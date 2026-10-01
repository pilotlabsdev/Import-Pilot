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

// --- Rate limiter for Shopify API ---
// Token bucket: 5 tokens/sec refill, burst of 10.
// Shopify cost-based throttling: queries = 1pt, mutations = 10pt.
// At 5 req/s we stay well under the ~50 req/s limit for any mix of operations.

const MAX_CONCURRENT = 10;
const TOKENS_PER_SECOND = 5;
const MAX_BURST = 10;

let tokens = MAX_BURST;
let lastRefill = Date.now();
const queue: Array<() => void> = [];

function refillTokens(): void {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  if (elapsed > 0) {
    // A4: clamp ≥0 — el bucket nunca acumula deuda negativa
    tokens = Math.min(MAX_BURST, Math.max(0, tokens + elapsed * TOKENS_PER_SECOND));
    lastRefill = now;
  }
}

function waitForToken(): Promise<void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      refillTokens();
      if (tokens >= 1) {
        tokens -= 1;
        resolve();
        return;
      }
      // A4: re-check en bucle en vez de dormir una vez y restar "a ciegas".
      // Antes N esperadores simultáneos calculaban la misma espera y todos
      // hacían tokens -= 1 al despertar → deuda negativa y esperas de ~100s.
      // Ahora solo se resta con tokens >= 1 (deuda imposible) y, con tokens
      // >= 0, la espera máxima por vuelta es 200ms → la cola se re-evalúa
      // constantemente y se distribuye a ritmo de 5 tokens/s.
      const waitMs = Math.ceil((1 - tokens) / TOKENS_PER_SECOND * 1000);
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
  isRetry = false
): Promise<any> {
  if (!isRetry) await waitForToken();
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
