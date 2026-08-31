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

export function isImportActive(configId: string): boolean {
  return activeImports.has(configId);
}

export function getActiveImportCount(): number {
  return activeImports.size;
}

// --- Rate limiter for Shopify API ---

const MAX_CONCURRENT = 10;
let tokens = MAX_CONCURRENT;
const queue: Array<() => void> = [];

function acquireToken(): Promise<void> {
  if (tokens > 0) {
    tokens--;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    queue.push(resolve);
  });
}

function releaseToken() {
  if (queue.length > 0) {
    const next = queue.shift()!;
    next();
  } else {
    tokens++;
  }
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
  await acquireToken();
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
        throw error;
      }
    }
  } finally {
    releaseToken();
  }
}
