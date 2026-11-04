import "dotenv/config";
import crypto from 'crypto';
import { execFile } from 'child_process';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const S3_CONFIG = {
  bucket: process.env.S3_BUCKET_NAME || 'madhu-cloud-organizer-storage-2026',
  region: process.env.AWS_REGION || process.env.S3_REGION || 'ap-southeast-2',
  accessKey: process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || '',
  secretKey: process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || '',
  defaultPresignedExpiration: Number(process.env.DEFAULT_PRESIGNED_EXPIRATION || 300),
};

if (Boolean(S3_CONFIG.accessKey) !== Boolean(S3_CONFIG.secretKey)) {
  throw new Error('Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or neither.');
}

const s3 = new S3Client({
  region: S3_CONFIG.region,
  ...(S3_CONFIG.accessKey && S3_CONFIG.secretKey
    ? { credentials: { accessKeyId: S3_CONFIG.accessKey, secretAccessKey: S3_CONFIG.secretKey } }
    : {}),
  
});

interface StoredObjectRecord {
  key: string;
  filename: string;
  category: string;
  bucket: string;
  contentType: string;
  sizeBytes: number;
  lastModified: string;
  etag: string;
  metadata: Record<string, string>;
  tags: Record<string, string>;
}

interface TrackedPresignedLink {
  id: string;
  url: string;
  directAnonymousUrl: string;
  bucket: string;
  objectKey: string;
  filename: string;
  category: string;
  expirationSeconds: number;
  issuedAt: string;
  expiresAt: string;
  issuedMs: number;
  expiresMs: number;
  objectRemainsPrivate: boolean;
}

const trackedPresignedLinks: TrackedPresignedLink[] = [];
let defaultExpirationSeconds = S3_CONFIG.defaultPresignedExpiration;

function sanitizeFilename(filename: string): string {
  const trimmed = String(filename || '').trim();
  if (!trimmed || trimmed.includes('\0')) throw new Error('File name cannot be empty or contain null bytes.');
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.split('/').includes('..') || normalized.startsWith('/')) throw new Error('Path traversal sequences are prohibited in file names.');
  const base = path.posix.basename(normalized).trim();
  if (!base || base === '.' || base === '..' || base.startsWith('.')) throw new Error('Invalid or hidden file name is not permitted.');
  return base.replace(/[^A-Za-z0-9._-]/g, '_');
}

function sanitizeCategoryPrefix(rawCategory: string): string {
  const cleaned = String(rawCategory || 'documents').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!cleaned || cleaned.includes('..') || cleaned.includes('\0')) throw new Error('Invalid category prefix.');
  const safe = cleaned.replace(/[^a-z0-9_-]/g, '-');
  if (!safe) throw new Error('Category prefix must contain alphanumeric characters.');
  return safe;
}

function normalizeMetadata(input: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const [key, value] of Object.entries(input)) {
    const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64);
    const cleanValue = String(value ?? '').trim().slice(0, 1800);
    if (cleanKey && cleanValue) result[cleanKey] = cleanValue;
  }
  return result;
}

function normalizeTags(input: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const [key, value] of Object.entries(input)) {
    const cleanKey = key.trim().slice(0, 128);
    const cleanValue = String(value ?? '').trim().slice(0, 256);
    if (cleanKey && cleanValue) result[cleanKey] = cleanValue;
  }
  if (Object.keys(result).length > 10) throw new Error('Amazon S3 allows a maximum of 10 object tags.');
  return result;
}

function toTaggingString(tags: Record<string, string>): string | undefined {
  const pairs = Object.entries(tags);
  if (!pairs.length) return undefined;
  return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

function parseTagSet(tagSet: Array<{ Key?: string; Value?: string }> = []): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const tag of tagSet) if (tag.Key) tags[tag.Key] = tag.Value || '';
  return tags;
}

function assertPrivateBucket(bucket: unknown): string {
  const name = String(bucket || S3_CONFIG.bucket);
  if (name !== S3_CONFIG.bucket) throw new Error('Only the configured private AWS S3 bucket is enabled. Public demo bucket operations are disabled.');
  return name;
}

async function getObjectRecord(key: string): Promise<StoredObjectRecord | null> {
  try {
    const [head, tagResult] = await Promise.all([
      s3.send(new HeadObjectCommand({ Bucket: S3_CONFIG.bucket, Key: key })),
      s3.send(new GetObjectTaggingCommand({ Bucket: S3_CONFIG.bucket, Key: key })).catch(() => ({ TagSet: [] })),
    ]);
    const filename = path.posix.basename(key);
    const category = key.split('/')[0] || 'documents';
    return {
      key,
      filename,
      category,
      bucket: S3_CONFIG.bucket,
      contentType: head.ContentType || 'application/octet-stream',
      sizeBytes: Number(head.ContentLength || 0),
      lastModified: (head.LastModified || new Date()).toISOString(),
      etag: String(head.ETag || '').replace(/"/g, ''),
      metadata: head.Metadata || {},
      tags: parseTagSet(tagResult.TagSet || []),
    };
  } catch (error: any) {
    const status = error?.$metadata?.httpStatusCode;
    const name = error?.name || error?.Code;
    if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return null;
    throw error;
  }
}

async function listAllObjects(): Promise<StoredObjectRecord[]> {
  const records: StoredObjectRecord[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: S3_CONFIG.bucket,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    const keys = (page.Contents || []).map((item) => item.Key).filter((key): key is string => Boolean(key));
    const pageRecords = await Promise.all(keys.map((key) => getObjectRecord(key)));
    records.push(...pageRecords.filter((record): record is StoredObjectRecord => record !== null));
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return records;
}

function serializeObject(obj: StoredObjectRecord) {
  return {
    ...obj,
    accessMode: 'Private',
  };
}

function basicAuth(req: Request, res: Response, next: NextFunction) {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;
  if (!username && !password) return next();
  if (!username || !password) return res.status(500).send('Both APP_USERNAME and APP_PASSWORD must be configured.');
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '';
  const separator = supplied.indexOf(':');
  const suppliedUser = separator >= 0 ? supplied.slice(0, separator) : '';
  const suppliedPassword = separator >= 0 ? supplied.slice(separator + 1) : '';
  const safeEqual = (a: string, b: string) => {
    const aa = Buffer.from(a);
    const bb = Buffer.from(b);
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  };
  if (safeEqual(suppliedUser, username) && safeEqual(suppliedPassword, password)) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Cloud Storage Organizer"');
  return res.status(401).send('Authentication required.');
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  if (
    process.env.NODE_ENV === 'production' &&
    (!process.env.APP_USERNAME || !process.env.APP_PASSWORD)
  ) {
    throw new Error(
      'APP_USERNAME and APP_PASSWORD are required in production.'
    );
  }

  app.disable('x-powered-by');

  // Public health check for Render
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // Protect the application and API routes
  app.use(basicAuth);
  app.use((req, res, next) => {
    const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((item) => item.trim()).filter(Boolean);
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : origin!);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '40mb' }));

  app.get('/api/storage/status', async (_req: Request, res: Response) => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: S3_CONFIG.bucket }));
      const objects = await listAllObjects();
      const categoryBreakdown: Record<string, { count: number; bytes: number }> = {
        documents: { count: 0, bytes: 0 }, images: { count: 0, bytes: 0 }, reports: { count: 0, bytes: 0 }, projects: { count: 0, bytes: 0 },
      };
      for (const object of objects) {
        if (!categoryBreakdown[object.category]) categoryBreakdown[object.category] = { count: 0, bytes: 0 };
        categoryBreakdown[object.category].count += 1;
        categoryBreakdown[object.category].bytes += object.sizeBytes;
      }
      const now = Date.now();
      res.json({
        connected: true,
        service: 'Amazon S3',
        endpointUrl: `https://s3.${S3_CONFIG.region}.amazonaws.com`,
        region: S3_CONFIG.region,
        privateBucket: S3_CONFIG.bucket,
        publicDemoBucket: '',
        publicDemoModeEnabled: false,
        defaultPresignedExpiration: defaultExpirationSeconds,
        stats: {
          totalFiles: objects.length,
          privateFiles: objects.length,
          sandboxFiles: 0,
          totalBytes: objects.reduce((sum, item) => sum + item.sizeBytes, 0),
          activeTemporaryLinks: trackedPresignedLinks.filter((link) => link.expiresMs > now).length,
          totalTrackedLinks: trackedPresignedLinks.length,
        },
        categoryBreakdown,
      });
    } catch (error: any) {
      // Log only AWS error metadata; never log credentials or request headers.
      console.error('AWS STATUS CHECK FAILED:', {
        name: error?.name,
        code: error?.Code || error?.code,
        httpStatus: error?.$metadata?.httpStatusCode,
        message: error?.message,
        requestId: error?.$metadata?.requestId,
      });
      res.status(503).json({
        connected: false,
        service: 'Amazon S3',
        region: S3_CONFIG.region,
        privateBucket: S3_CONFIG.bucket,
        error: error?.message || 'Could not connect to the configured S3 bucket.',
      });
    }
  });

  app.get('/api/storage/objects', async (req: Request, res: Response) => {
    try {
      const categoryFilter = String(req.query.category || 'all').toLowerCase();
      const searchQuery = String(req.query.search || '').trim().toLowerCase();
      let records = await listAllObjects();
      if (categoryFilter !== 'all') records = records.filter((item) => item.category === categoryFilter);
      if (searchQuery) records = records.filter((item) => {
        const metadataText = Object.entries(item.metadata).map(([key, value]) => `${key}=${value}`).join(' ');
        const tagText = Object.entries(item.tags).map(([key, value]) => `${key}=${value}`).join(' ');
        return `${item.key} ${item.filename} ${metadataText} ${tagText}`.toLowerCase().includes(searchQuery);
      });
      res.json({ objects: records.map(serializeObject) });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Could not list S3 objects.' });
    }
  });

  app.post('/api/storage/upload', async (req: Request, res: Response) => {
    try {
      const { filename, category = 'documents', contentType = 'application/octet-stream', contentBase64, metadata = {}, tags = {}, usePublicDemoBucket = false } = req.body || {};
      if (usePublicDemoBucket) return res.status(403).json({ error: 'Public demo uploads are disabled. This deployment keeps every object private.' });
      if (typeof contentBase64 !== 'string' || !contentBase64) return res.status(400).json({ error: 'A base64-encoded file body is required.' });
      const cleanFilename = sanitizeFilename(filename);
      const normalizedCategory = sanitizeCategoryPrefix(String(category));
      const key = `${normalizedCategory}/${cleanFilename}`;
      const body = Buffer.from(contentBase64, 'base64');
      if (!body.length) return res.status(400).json({ error: 'The uploaded file is empty or its base64 data is invalid.' });
      const cleanMetadata = normalizeMetadata(metadata);
      const cleanTags = normalizeTags(tags);
      if (!Object.keys(cleanTags).length) cleanTags.Category = normalizedCategory;
      await s3.send(new PutObjectCommand({
        Bucket: S3_CONFIG.bucket,
        Key: key,
        Body: body,
        ContentType: String(contentType || 'application/octet-stream'),
        Metadata: cleanMetadata,
        Tagging: toTaggingString(cleanTags),
        ServerSideEncryption: 'AES256',
      }));
      const record = await getObjectRecord(key);
      if (!record) throw new Error('Upload succeeded but the object could not be read back from S3.');
      res.status(201).json({ message: `Uploaded '${cleanFilename}' to '${normalizedCategory}/' (Private AWS S3).`, object: serializeObject(record) });
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Upload failed.' });
    }
  });

  app.put('/api/storage/tags', async (req: Request, res: Response) => {
    try {
      const bucket = assertPrivateBucket(req.body?.bucket);
      const key = String(req.body?.key || '');
      if (!key || key.includes('..') || key.startsWith('/')) return res.status(400).json({ error: 'A valid object key is required.' });
      const current = await getObjectRecord(key);
      if (!current) return res.status(404).json({ error: `Object '${key}' not found in bucket '${bucket}'.` });
      const updatedMetadata = req.body?.metadata === undefined ? current.metadata : normalizeMetadata(req.body.metadata);
      const updatedTags = req.body?.tags === undefined ? current.tags : normalizeTags(req.body.tags);
      // S3 user metadata is immutable: copy the object onto itself with replacement metadata.
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: key,
        CopySource: `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
        MetadataDirective: 'REPLACE',
        Metadata: updatedMetadata,
        ContentType: current.contentType,
        ServerSideEncryption: 'AES256',
      }));
      await s3.send(new PutObjectTaggingCommand({ Bucket: bucket, Key: key, Tagging: { TagSet: Object.entries(updatedTags).map(([Key, Value]) => ({ Key, Value })) } }));
      const updated = await getObjectRecord(key);
      if (!updated) throw new Error('Could not read the updated object from S3.');
      res.json({ message: `Saved metadata and tags for '${updated.filename}'.`, object: serializeObject(updated) });
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Could not update object metadata and tags.' });
    }
  });

  app.get('/api/storage/download', async (req: Request, res: Response) => {
    try {
      assertPrivateBucket(req.query.bucket);
      const key = String(req.query.key || '');
      if (!key || key.includes('..') || key.startsWith('/')) return res.status(400).json({ error: 'A valid object key is required.' });
      const object = await s3.send(new GetObjectCommand({ Bucket: S3_CONFIG.bucket, Key: key }));
      const bytes = await object.Body?.transformToByteArray();
      if (!bytes) return res.status(404).json({ error: 'The requested object has no body.' });
      const filename = path.posix.basename(key).replace(/["\r\n]/g, '_');
      res.setHeader('Content-Type', object.ContentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (object.ETag) res.setHeader('ETag', object.ETag);
      res.send(Buffer.from(bytes));
    } catch (error: any) {
      const status = error?.$metadata?.httpStatusCode === 404 ? 404 : 500;
      res.status(status).json({ error: error.message || 'Download failed.' });
    }
  });

  app.delete('/api/storage/object', async (req: Request, res: Response) => {
    try {
      const bucket = assertPrivateBucket(req.body?.bucket);
      const key = String(req.body?.key || '');
      if (!req.body?.confirmed) return res.status(400).json({ error: 'Explicit confirmation is required before deleting a file.' });
      const existing = await getObjectRecord(key);
      if (!existing) return res.status(404).json({ error: `NoSuchKey: Object '${key}' does not exist.` });
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      for (let i = trackedPresignedLinks.length - 1; i >= 0; i--) {
        if (trackedPresignedLinks[i].bucket === bucket && trackedPresignedLinks[i].objectKey === key) trackedPresignedLinks.splice(i, 1);
      }
      res.json({ message: `Deleted '${existing.filename}' permanently from AWS S3.`, deleted: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Delete failed.' });
    }
  });

  app.post('/api/storage/public-demo', (_req: Request, res: Response) => {
    res.status(403).json({ publicDemoModeEnabled: false, error: 'Public demo mode is disabled in this private-by-default AWS deployment.' });
  });

  app.put('/api/storage/settings', (req: Request, res: Response) => {
    const parsed = Number(req.body?.defaultPresignedExpiration);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 604800) return res.status(400).json({ error: 'Default expiration must be between 1 and 604800 seconds.' });
    defaultExpirationSeconds = parsed;
    res.json({ message: `Updated default temporary link expiration to ${parsed} seconds.`, defaultPresignedExpiration: defaultExpirationSeconds });
  });

  app.get('/api/storage/presigned-links', (_req: Request, res: Response) => {
    const now = Date.now();
    res.json({ links: trackedPresignedLinks.map((item) => ({ ...item, isExpired: now > item.expiresMs, remainingSeconds: Math.max(0, Math.ceil((item.expiresMs - now) / 1000)) })) });
  });

  app.post('/api/storage/presign', async (req: Request, res: Response) => {
    try {
      const bucket = assertPrivateBucket(req.body?.bucket);
      const key = String(req.body?.key || '');
      const expiry = Number(req.body?.expirationSeconds ?? defaultExpirationSeconds);
      const backdateSeconds = Math.max(0, Number(req.body?.backdateSeconds || 0));
      if (!key || key.includes('..') || key.startsWith('/')) return res.status(400).json({ error: 'A valid object key is required.' });
      if (!Number.isFinite(expiry) || expiry < 1 || expiry > 604800) return res.status(400).json({ error: 'Expiration must be between 1 and 604800 seconds.' });
      const record = await getObjectRecord(key);
      if (!record) return res.status(404).json({ error: `NoSuchKey: Cannot pre-sign missing object '${key}'.` });
      const issuedMs = Date.now() - backdateSeconds * 1000;
      const issuedDate = new Date(issuedMs);
      const expiresMs = issuedMs + expiry * 1000;
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiry, signingDate: issuedDate });
      const encodedKey = key.split('/').map(encodeURIComponent).join('/');
      const directAnonymousUrl = `/s3/${encodeURIComponent(bucket)}/${encodedKey}`;
      const linkEntry: TrackedPresignedLink = {
        id: crypto.randomUUID(), url, directAnonymousUrl, bucket, objectKey: key, filename: record.filename, category: record.category,
        expirationSeconds: expiry, issuedAt: issuedDate.toISOString(), expiresAt: new Date(expiresMs).toISOString(), issuedMs, expiresMs, objectRemainsPrivate: true,
      };
      trackedPresignedLinks.unshift(linkEntry);
      if (trackedPresignedLinks.length > 25) trackedPresignedLinks.pop();
      res.json(linkEntry);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Could not generate a pre-signed URL.' });
    }
  });

  // This route deliberately rejects anonymous object requests. Valid share URLs
  // are signed by AWS and point directly to the private S3 object.
  app.get('/s3/:bucket/*', (_req: Request, res: Response) => {
    res.status(403).json({ Error: { Code: 'AccessDenied', Message: 'Access denied. Objects are private; use a valid AWS S3 pre-signed URL.' } });
  });

  app.post('/api/tests/run', (_req: Request, res: Response) => {
    const startTime = Date.now();
    execFile(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], { cwd: __dirname, timeout: 60000 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - startTime;
      const combinedOutput = `${stdout || ''}\n${stderr || ''}`.trim();
      const lines = combinedOutput.split('\n');
      const tests: Array<{ name: string; suite: string; description: string; status: 'PASS' | 'FAIL' }> = [];
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].trim().match(/^(test_\w+)\s+\(([^)]+)\)/);
        if (!match) continue;
        const line = lines[i].trim();
        const nextLine = (lines[i + 1] || '').trim();
        const passed = line.endsWith('... ok') || nextLine.endsWith('... ok');
        tests.push({ name: match[1], suite: match[2], description: nextLine.replace(/\s*\.\.\.\s*(ok|ERROR|FAIL).*$/i, '').trim() || match[1], status: passed ? 'PASS' : 'FAIL' });
      }
      const passedCount = tests.filter((test) => test.status === 'PASS').length;
      res.json({ passed: !error && tests.length > 0 && passedCount === tests.length, durationMs, totalTests: tests.length, passedCount, failedCount: tests.length - passedCount, tests, rawOutput: combinedOutput || (error ? error.message : 'No Python test output was produced.') });
    });
  });

  app.get('/api/project-files', (_req: Request, res: Response) => {
    const filePaths = ['app.py', 'config.py', 'docker-compose.yml', 'README.md', 'requirements.txt', 'storage_manager.py', 'tests/test_security.py', 'tests/test_storage_manager.py'];
    const files = filePaths.map((relPath) => {
      const absPath = path.join(__dirname, relPath);
      const content = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
      return { path: relPath, name: relPath, sizeBytes: Buffer.byteLength(content, 'utf8'), content };
    });
    res.json({ files });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => console.log(`Cloud Storage Organizer running on port ${PORT}; S3 bucket: ${S3_CONFIG.bucket} (${S3_CONFIG.region})`));
}

startServer().catch((error) => {
  console.error('Failed to start Cloud Storage Organizer:', error);
  process.exit(1);
});
