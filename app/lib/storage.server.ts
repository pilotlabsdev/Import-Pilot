import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const BUCKET = process.env.STORAGE_BUCKET || "";
const ENDPOINT = process.env.STORAGE_ENDPOINT || "";
const ACCESS_KEY = process.env.STORAGE_ACCESS_KEY || "";
const SECRET_KEY = process.env.STORAGE_SECRET_KEY || "";
const REGION = process.env.STORAGE_REGION || "auto";

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) {
    _client = new S3Client({
      endpoint: ENDPOINT,
      region: REGION,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      forcePathStyle: true,
    });
  }
  return _client;
}

export function isStorageConfigured(): boolean {
  return !!(BUCKET && ENDPOINT && ACCESS_KEY && SECRET_KEY);
}

/** Check if a localFilePath is a storage bucket key (not a local disk path). */
export function isBucketKey(path: string): boolean {
  return path.startsWith("bucket:");
}

/** Strip the "bucket:" prefix to get the raw S3 key. */
export function toS3Key(bucketKey: string): string {
  return bucketKey.startsWith("bucket:") ? bucketKey.slice(7) : bucketKey;
}

/** Build a bucket key from shopDomain + configId + filename. */
export function makeBucketKey(shopDomain: string, configId: string, fileName: string): string {
  return `bucket:${shopDomain}/${configId}/${fileName}`;
}

/** Upload a file buffer to the bucket. Returns the bucket key (with "bucket:" prefix). */
export async function uploadToStorage(
  shopDomain: string,
  configId: string,
  fileName: string,
  body: Buffer,
  contentType?: string
): Promise<string> {
  const key = `${shopDomain}/${configId}/${fileName}`;
  await getClient().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || "application/octet-stream",
  }));
  return `bucket:${key}`;
}

/** Delete a file from the bucket by its bucket key. */
export async function deleteFromStorage(bucketKey: string): Promise<void> {
  const key = toS3Key(bucketKey);
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (e: any) {
    console.error(`[Storage] Delete error key=${key}:`, e?.message);
  }
}

/** Check if a file exists in the bucket. */
export async function fileExistsInStorage(bucketKey: string): Promise<boolean> {
  const key = toS3Key(bucketKey);
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Generate a presigned URL (valid for 1 hour) for reading a file from the bucket. */
export async function getPresignedUrl(bucketKey: string): Promise<string> {
  const key = toS3Key(bucketKey);
  return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
}

/**
 * Resolve a localFilePath / csvUrl to a readable URL.
 * - Bucket keys ("bucket:...") → presigned URL
 * - HTTP/HTTPS URLs → returned as-is
 * - Local paths → returned as-is (legacy / dev mode)
 */
export async function resolveFileUrl(value: string): Promise<string> {
  if (isBucketKey(value)) {
    return getPresignedUrl(value);
  }
  return value;
}

/** Get file size from the bucket. Returns size in bytes or -1 if not found. */
export async function getFileSize(bucketKey: string): Promise<number> {
  const key = toS3Key(bucketKey);
  try {
    const res = await getClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return res.ContentLength ?? -1;
  } catch {
    return -1;
  }
}

/** List all files in a bucket prefix (shopDomain/configId/). */
export async function listStorageFiles(shopDomain: string, configId: string): Promise<Array<{ key: string; name: string; size: number }>> {
  // We use a simple approach: try to get individual files isn't practical for listing.
  // Instead, the upload route tracks files via DB. This is a fallback.
  return [];
}
