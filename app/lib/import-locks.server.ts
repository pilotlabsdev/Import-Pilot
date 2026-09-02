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

function refillTokens() {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  if (elapsed > 0) {
    tokens = Math.min(MAX_BURST, tokens + elapsed * TOKENS_PER_SECOND);
    lastRefill = now;
  }
}

function waitForToken(): Promise<void> {
  refillTokens();
  if (tokens >= 1) {
    tokens -= 1;
    return Promise.resolve();
  }
  // Wait until at least 1 token is available
  const waitMs = Math.ceil((1 - tokens) / TOKENS_PER_SECOND * 1000);
  return new Promise((resolve) => {
    setTimeout(() => {
      refillTokens();
      tokens -= 1;
      resolve();
    }, waitMs);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function rateLimitedGraphql(
  admin: any,
  query: string,
  vars: any,
  maxRetries = 3
): Promise<any> {
  await waitForToken();
  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await admin.graphql(query, { variables: vars });
        const json = await res.json();
        const gqlErrors = json.errors || [];
        const isThrottled = gqlErrors.some((e: any) =>
          e.message?.includes("Throttled") ||
          e.message?.includes("THROTTLED") ||
          e.extensions?.code === "THROTTLED" ||
          e.extensions?.code === "too_many_requests"
        );
        if (isThrottled && attempt < maxRetries) {
          const wait = attempt * 2000;
          console.log(`[RateLimit] Throttled (GQL), retrying in ${wait}ms (attempt ${attempt}/${maxRetries})`);
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
          console.log(`[Auth] Unauthorized (GQL), retrying in ${wait}ms (attempt ${attempt}/${maxRetries})`);
          await sleep(wait);
          continue;
        }
        return json;
      } catch (error: any) {
        const msg = error?.message || error?.toString() || "";
        const statusCode = error?.response?.status || error?.status || 0;
        const isThrottled = statusCode === 429 ||
          msg.includes("Throttled") ||
          msg.includes("THROTTLED") ||
          msg.includes("too_many_requests") ||
          msg.includes("rate limit");
        if (isThrottled && attempt < maxRetries) {
          const wait = attempt * 2000;
          console.log(`[RateLimit] Throttled (HTTP ${statusCode}), retrying in ${wait}ms (attempt ${attempt}/${maxRetries})`);
          await sleep(wait);
          continue;
        }
        const isUnauthorized = statusCode === 401 ||
          msg.includes("Unauthorized") ||
          msg.includes("Session not found") ||
          msg.includes("invalid_token");
        if (isUnauthorized && attempt < maxRetries) {
          const wait = attempt * 3000;
          console.log(`[Auth] Unauthorized (HTTP ${statusCode}), retrying in ${wait}ms (attempt ${attempt}/${maxRetries})`);
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
