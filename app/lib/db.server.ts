import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

const prisma = global.prisma || new PrismaClient({
  log: ["error", "warn"],
  datasourceUrl: process.env.DATABASE_URL,
});

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}

export { prisma };

const TOKEN_EXPIRY_WARNING_MS = 10 * 60 * 1000; // 10 minutes before expiry

/**
 * Returns the effective data source URL for a config.
 * If dataSource is "file", returns localFilePath. Otherwise returns csvUrl.
 */
export function getEffectiveUrl(config: { dataSource?: string | null; csvUrl?: string; localFilePath?: string | null }): string {
  if (config.dataSource === "file" && config.localFilePath) {
    return config.localFilePath;
  }
  return config.csvUrl || "";
}

/**
 * Check if the data source is a URL (http/https).
 */
export function isUrlSource(config: { dataSource?: string | null }): boolean {
  return config.dataSource !== "file";
}

/**
 * Delete all sessions for a shop except the given one.
 * Called after OAuth (afterAuth hook) to prevent stale sessions from
 * accumulating when a merchant reinstalls. The PrismaSessionStorage
 * upserts by session.id (PK), not by shop — so reinstalling creates
 * a new row instead of updating the old one.
 */
export async function cleanupDuplicateSessions(shop: string, keepSessionId: string): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: {
      shop,
      id: { not: keepSessionId },
    },
  });
  if (result.count > 0) {
    console.log(`[Session] Cleaned up ${result.count} stale session(s) for ${shop}`);
  }
  return result.count;
}

/**
 * Ensure there's only one valid session for a shop.
 * Returns the best session (the one most likely to have a valid token), or null.
 * Called before bulk import to guarantee the correct token is used.
 *
 * Ordering strategy (PostgreSQL NULLS LAST workaround):
 * 1. Non-expired sessions with concrete expiry first (ordered by latest expiry)
 * 2. Non-expired sessions with null expiry (offline sessions)
 * 3. Expired sessions with concrete expiry
 * 4. Expired sessions with null expiry
 *
 * PrismaSessionStorage upserts by session.id, so reinstalls create new rows.
 * This function keeps only the best and deletes the rest.
 */
export async function ensureSingleSession(shop: string): Promise<{ id: string; accessToken: string; expires: Date | null } | null> {
  const now = new Date();
  const sessions = await prisma.session.findMany({
    where: { shop },
    select: { id: true, accessToken: true, expires: true },
  });

  if (sessions.length === 0) {
    console.log(`[Session] No sessions found for ${shop}`);
    return null;
  }

  if (sessions.length === 1) {
    const s = sessions[0];
    const isExpired = s.expires ? new Date(s.expires) < now : false;
    console.log(`[Session] Single session for ${shop}: id=${s.id}, expires=${s.expires?.toISOString() || "null"}, isExpired=${isExpired}`);
    return s;
  }

  // Multiple sessions: pick the best one
  // Priority: non-expired with concrete expiry > non-expired null expiry > expired with concrete expiry > expired null expiry
  const scored = sessions.map((s) => {
    const isExpired = s.expires ? new Date(s.expires) < now : false;
    const hasConcreteExpiry = s.expires !== null;
    // Score: higher is better
    // non-expired + concrete = 3, non-expired + null = 2, expired + concrete = 1, expired + null = 0
    let score = isExpired ? 0 : 2;
    if (!isExpired && hasConcreteExpiry) score = 3;
    if (isExpired && hasConcreteExpiry) score = 1;
    return { ...s, score, isExpired, expiresTime: s.expires ? new Date(s.expires).getTime() : 0 };
  });

  scored.sort((a, b) => {
    // Higher score first
    if (b.score !== a.score) return b.score - a.score;
    // Same score: later expiry first
    return b.expiresTime - a.expiresTime;
  });

  const [best, ...stale] = scored;
  const idsToDelete = stale.map((s) => s.id);
  await prisma.session.deleteMany({ where: { id: { in: idsToDelete } } });
  console.log(`[Session] Deduped ${idsToDelete.length} stale session(s) for ${shop}: kept id=${best.id} (score=${best.score}, expired=${best.isExpired}), deleted [${idsToDelete.join(", ")}]`);
  return best;
}

/**
 * Returns a unique key for the current data source.
 * Used to scope column mappings per source (URL vs file).
 */
export function getSourceKey(config: { dataSource?: string | null; csvUrl?: string; localFilePath?: string | null }): string {
  if (config.dataSource === "file" && config.localFilePath) return `file:${config.localFilePath}`;
  if (config.csvUrl) return `url:${config.csvUrl}`;
  return "default";
}

/**
 * Get or create the first ImportConfig for a shop.
 * Used for backward compatibility during multi-supplier migration.
 * When multiple configs exist, returns the most recently active one,
 * or the most recently created one.
 */
export async function getOrCreateConfig(shopDomain: string) {
  const existing = await prisma.importConfig.findFirst({
    where: { shopDomain },
    orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
  });
  if (existing) return existing;

  return prisma.importConfig.create({
    data: {
      shopDomain,
      csvUrl: "",
      name: "Proveedor",
    },
  });
}

/**
 * Get a specific ImportConfig by ID
 */
export async function getConfigById(id: string) {
  return prisma.importConfig.findUnique({ where: { id } });
}

const MAX_LOGS_PER_CONFIG = 100;

export async function cleanupOldLogs(configId: string): Promise<number> {
  const allLogs = await prisma.importLog.findMany({
    where: { configId },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });

  if (allLogs.length <= MAX_LOGS_PER_CONFIG) return 0;

  const idsToDelete = allLogs.slice(MAX_LOGS_PER_CONFIG).map((l) => l.id);
  const result = await prisma.importLog.deleteMany({
    where: { id: { in: idsToDelete } },
  });

  console.log(`[Cleanup] Deleted ${result.count} old logs for config ${configId}`);
  return result.count;
}

/**
 * Refresh an expiring offline access token using its refresh_token.
 * Returns the new accessToken, or null if refresh failed.
 * Called before bulk imports when the token is about to expire.
 *
 * Flow: POST https://{shop}/admin/oauth/access_token
 *   grant_type=refresh_token
 *   client_id={SHOPIFY_API_KEY}
 *   client_secret={SHOPIFY_API_SECRET}
 *   refresh_token={stored refresh token}
 */
export async function refreshAccessToken(shop: string): Promise<string | null> {
  const session = await prisma.session.findFirst({
    where: { shop },
    select: { id: true, refreshToken: true, refreshTokenExpires: true },
    orderBy: { expires: "desc" },
  });

  if (!session?.refreshToken) {
    console.error(`[Token Refresh] No refresh token for ${shop}. Merchant must reinstall app.`);
    return null;
  }

  // Check if refresh token itself is expired
  if (session.refreshTokenExpires && new Date(session.refreshTokenExpires) < new Date()) {
    console.error(`[Token Refresh] Refresh token expired for ${shop} (expired: ${session.refreshTokenExpires}). Merchant must reinstall app.`);
    return null;
  }

  console.log(`[Token Refresh] Refreshing token for ${shop}...`);

  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: process.env.SHOPIFY_API_KEY!,
        client_secret: process.env.SHOPIFY_API_SECRET!,
        refresh_token: session.refreshToken,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[Token Refresh] Failed for ${shop}: HTTP ${response.status} - ${body}`);
      return null;
    }

    const data = await response.json();
    const { access_token, refresh_token, expires_in, refresh_token_expires_in } = data;

    // Update session in DB
    const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;
    const refreshExpiresAt = refresh_token_expires_in ? new Date(Date.now() + refresh_token_expires_in * 1000) : null;

    await prisma.session.update({
      where: { id: session.id },
      data: {
        accessToken: access_token,
        expires: expiresAt,
        refreshToken: refresh_token || session.refreshToken,
        refreshTokenExpires: refreshExpiresAt || session.refreshTokenExpires,
      },
    });

    console.log(`[Token Refresh] OK for ${shop}: new token, expires=${expiresAt?.toISOString() || "null"}, refreshExpires=${refreshExpiresAt?.toISOString() || "null"}`);
    return access_token;
  } catch (err: any) {
    console.error(`[Token Refresh] Error for ${shop}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Check if a session token needs refreshing and do it if so.
 * Returns the (possibly refreshed) accessToken, or null if token is unusable.
 *
 * - Token expired or expiring within 10 min → refresh
 * - Refresh token expired → return null (merchant must reinstall)
 * - No refresh token → return null
 */
export async function ensureFreshToken(shop: string): Promise<string | null> {
  const session = await prisma.session.findFirst({
    where: { shop },
    select: { accessToken: true, expires: true, refreshToken: true, refreshTokenExpires: true },
    orderBy: { expires: "desc" },
  });

  if (!session) {
    console.error(`[Token] No session for ${shop}`);
    return null;
  }

  const now = Date.now();
  const expiresAt = session.expires ? new Date(session.expires).getTime() : Infinity;
  const msUntilExpiry = expiresAt - now;

  // Token still valid and not about to expire
  if (msUntilExpiry > TOKEN_EXPIRY_WARNING_MS) {
    return session.accessToken;
  }

  // Token expired or expiring soon → refresh
  if (msUntilExpiry <= TOKEN_EXPIRY_WARNING_MS) {
    console.log(`[Token] Token for ${shop} expiring in ${Math.round(msUntilExpiry / 1000)}s, refreshing...`);
    return refreshAccessToken(shop);
  }

  return session.accessToken;
}
