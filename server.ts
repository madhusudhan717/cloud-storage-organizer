import crypto from 'crypto';
import { execFile } from 'child_process';
import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const S3_CONFIG = {
  endpointUrl: process.env.S3_ENDPOINT_URL || 'http://localhost:9000',
  accessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.S3_SECRET_KEY || 'minioadmin_local_dev_secret_key',
  privateBucket: process.env.S3_BUCKET_NAME || 'cloud-organizer-private',
  publicDemoBucket: process.env.S3_PUBLIC_DEMO_BUCKET || 'cloud-organizer-public-sandbox',
  region: process.env.S3_REGION || 'us-east-1',
  defaultPresignedExpiration: Number(process.env.DEFAULT_PRESIGNED_EXPIRATION || 300),
};

const CORE_CATEGORIES = ['documents', 'images', 'reports', 'projects'] as const;

interface StoredObjectRecord {
  key: string;
  filename: string;
  category: string;
  bucket: string;
  contentType: string;
  sizeBytes: number;
  lastModified: string;
  etag: string;
  body: Buffer;
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

const buckets: Record<string, Map<string, StoredObjectRecord>> = {
  [S3_CONFIG.privateBucket]: new Map(),
  [S3_CONFIG.publicDemoBucket]: new Map(),
};

const trackedPresignedLinks: TrackedPresignedLink[] = [];

let publicDemoModeEnabled = false;
let defaultExpirationSeconds = S3_CONFIG.defaultPresignedExpiration;

function sanitizeFilename(filename: string): string {
  const trimmed = (filename || '').trim();
  if (!trimmed || trimmed.includes('\0')) {
    throw new Error('File name cannot be empty or contain null bytes.');
  }
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.split('/').includes('..') || normalized.startsWith('/')) {
    throw new Error('Path traversal sequences are prohibited in file names.');
  }
  const base = path.posix.basename(normalized).trim();
  if (!base || base === '.' || base === '..' || base.startsWith('.')) {
    throw new Error('Invalid or hidden file name is not permitted.');
  }
  return base.replace(/[^A-Za-z0-9._-]/g, '_');
}

function sanitizeCategoryPrefix(rawCategory: string): string {
  const cleaned = (rawCategory || 'documents')
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '');
  if (!cleaned || cleaned.includes('..') || cleaned.includes('\0')) {
    throw new Error('Invalid category prefix.');
  }
  const safe = cleaned.replace(/[^a-z0-9_-]/g, '-');
  if (!safe) {
    throw new Error('Category prefix must contain alphanumeric characters.');
  }
  return safe;
}

function seedInitialObjects(): void {
  const seedItems: Array<{
    filename: string;
    category: string;
    contentType: string;
    content: string;
    metadata: Record<string, string>;
    tags: Record<string, string>;
  }> = [
    {
      filename: 'zero_trust_storage_policy_v2.pdf',
      category: 'documents',
      contentType: 'application/pdf',
      content:
        '%PDF-1.7\nCloud Security Architecture — Zero-Trust Object Storage Standard\n1. All primary buckets enforce private-by-default ACLs.\n2. External sharing requires HMAC-SHA256 pre-signed URLs with bounded TTL.\n',
      metadata: {
        department: 'Cloud Security',
        owner: 'Elena Rostova',
        description: 'Zero-trust S3 and MinIO bucket governance policy document',
      },
      tags: {
        Category: 'Academic',
        Type: 'Policy',
        Department: 'Security',
      },
    },
    {
      filename: 'cloud_onboarding_handbook.pdf',
      category: 'documents',
      contentType: 'application/pdf',
      content:
        '%PDF-1.7\nBeginner Guide to Object Storage, Prefixes, Metadata, and Pre-Signed Sharing.\n',
      metadata: {
        department: 'IT Operations',
        owner: 'Marcus Vance',
        description: 'Step-by-step onboarding guide for organizing team cloud files',
      },
      tags: {
        Category: 'Academic',
        Type: 'Guide',
        Department: 'IT',
      },
    },
    {
      filename: 'q3_bucket_access_audit.csv',
      category: 'reports',
      contentType: 'text/csv',
      content:
        'timestamp_utc,bucket,object_key,principal,action,http_status\n2026-10-19T14:20:00Z,cloud-organizer-private,documents/zero_trust_storage_policy_v2.pdf,anonymous,s3:GetObject,403\n2026-10-19T14:21:12Z,cloud-organizer-private,documents/zero_trust_storage_policy_v2.pdf,presigned-sigv4,s3:GetObject,200\n2026-10-19T14:28:05Z,cloud-organizer-private,documents/zero_trust_storage_policy_v2.pdf,expired-sigv4,s3:GetObject,403\n',
      metadata: {
        department: 'Compliance',
        owner: 'Audit Automation',
        description: 'Quarterly S3 access control verification log and security metrics',
      },
      tags: {
        Category: 'Academic',
        Type: 'Report',
        Quarter: 'Q3',
      },
    },
    {
      filename: 'minio_cluster_topology.svg',
      category: 'images',
      contentType: 'image/svg+xml',
      content:
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240"><rect width="480" height="240" rx="16" fill="#eef2ff"/><rect x="24" y="28" width="432" height="44" rx="10" fill="#4f46e5"/><text x="44" y="55" fill="#ffffff" font-family="sans-serif" font-weight="bold" font-size="15">MinIO S3-Compatible Storage Topology</text><rect x="24" y="92" width="204" height="120" rx="12" fill="#ffffff" stroke="#6366f1" stroke-width="2"/><text x="42" y="125" fill="#1e1b4b" font-family="sans-serif" font-weight="bold" font-size="13">cloud-organizer-private</text><text x="42" y="150" fill="#0d9488" font-family="sans-serif" font-size="12">Private by Default (Protected)</text><text x="42" y="175" fill="#64748b" font-family="sans-serif" font-size="11">Anonymous HTTP: 403 Denied</text><rect x="252" y="92" width="204" height="120" rx="12" fill="#ffffff" stroke="#f59e0b" stroke-width="2"/><text x="270" y="125" fill="#1e1b4b" font-family="sans-serif" font-weight="bold" font-size="13">public-sandbox (Isolated)</text><text x="270" y="150" fill="#d97706" font-family="sans-serif" font-size="12">Opt-In Demo Bucket Only</text><text x="270" y="175" fill="#64748b" font-family="sans-serif" font-size="11">Never weakens private vault</text></svg>',
      metadata: {
        department: 'Platform Engineering',
        owner: 'Priya Nair',
        description: 'Visual architecture diagram of private vs isolated sandbox buckets',
      },
      tags: {
        Category: 'Engineering',
        Type: 'Diagram',
        Project: 'Topology',
      },
    },
    {
      filename: 'boto3_migration_manifest.json',
      category: 'projects',
      contentType: 'application/json',
      content: JSON.stringify(
        {
          project: 'Cloud Storage Organizer',
          sdk: 'boto3 >= 1.34.0',
          signatureVersion: 's3v4',
          categories: ['documents/', 'images/', 'reports/', 'projects/'],
          privateByDefault: true,
        },
        null,
        2
      ),
      metadata: {
        department: 'Core Platform',
        owner: 'Python Guild',
        description: 'Boto3 S3v4 client configuration manifest and prefix schema',
      },
      tags: {
        Category: 'Project',
        Type: 'Manifest',
        Department: 'Engineering',
      },
    },
  ];

  seedItems.forEach((item, index) => {
    const key = `${item.category}/${item.filename}`;
    const body = Buffer.from(item.content, 'utf-8');
    const etag = crypto.createHash('md5').update(body).digest('hex');
    const timestamp = new Date(Date.now() - (seedItems.length - index) * 3600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');

    buckets[S3_CONFIG.privateBucket].set(key, {
      key,
      filename: item.filename,
      category: item.category,
      bucket: S3_CONFIG.privateBucket,
      contentType: item.contentType,
      sizeBytes: body.length,
      lastModified: timestamp,
      etag,
      body,
      metadata: item.metadata,
      tags: item.tags,
    });
  });
}

seedInitialObjects();

function signPresignedParams(
  bucket: string,
  key: string,
  amzDate: string,
  expiresSeconds: number,
  issuedMs: number,
  credential: string
): string {
  const canonical = `GET\n/${bucket}/${key}\n${amzDate}\n${expiresSeconds}\n${issuedMs}\n${credential}`;
  return crypto
    .createHmac('sha256', S3_CONFIG.secretKey)
    .update(canonical, 'utf-8')
    .digest('hex');
}

function serializeObject(obj: StoredObjectRecord) {
  const isSandbox = obj.bucket === S3_CONFIG.publicDemoBucket;
  return {
    key: obj.key,
    filename: obj.filename,
    category: obj.category,
    bucket: obj.bucket,
    contentType: obj.contentType,
    sizeBytes: obj.sizeBytes,
    lastModified: obj.lastModified,
    etag: obj.etag,
    accessMode: isSandbox && publicDemoModeEnabled ? 'Public-Read (Isolated Sandbox)' : 'Private',
    metadata: obj.metadata,
    tags: obj.tags,
  };
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '25mb' }));

  // ---------------------------------------------------------------------------
  // 1. Storage Connection, Summary Metrics & Category Breakdown (No Secrets)
  // ---------------------------------------------------------------------------
  app.get('/api/storage/status', (_req: Request, res: Response) => {
    const privateObjects = Array.from(buckets[S3_CONFIG.privateBucket].values());
    const sandboxObjects = Array.from(buckets[S3_CONFIG.publicDemoBucket].values());
    const allObjects = [...privateObjects, ...sandboxObjects];
    const totalBytes = allObjects.reduce((acc, o) => acc + o.sizeBytes, 0);

    const nowMs = Date.now();
    const activeLinksCount = trackedPresignedLinks.filter((l) => l.expiresMs > nowMs).length;

    const categoryBreakdown: Record<string, { count: number; bytes: number }> = {
      documents: { count: 0, bytes: 0 },
      images: { count: 0, bytes: 0 },
      reports: { count: 0, bytes: 0 },
      projects: { count: 0, bytes: 0 },
    };

    for (const obj of allObjects) {
      if (!categoryBreakdown[obj.category]) {
        categoryBreakdown[obj.category] = { count: 0, bytes: 0 };
      }
      categoryBreakdown[obj.category].count += 1;
      categoryBreakdown[obj.category].bytes += obj.sizeBytes;
    }

    const privateFilesCount = allObjects.filter(
      (o) => !(o.bucket === S3_CONFIG.publicDemoBucket && publicDemoModeEnabled)
    ).length;

    res.json({
      connected: true,
      service: 'MinIO / AWS S3v4 Compatible Storage',
      endpointUrl: S3_CONFIG.endpointUrl,
      region: S3_CONFIG.region,
      privateBucket: S3_CONFIG.privateBucket,
      publicDemoBucket: S3_CONFIG.publicDemoBucket,
      publicDemoModeEnabled,
      defaultPresignedExpiration: defaultExpirationSeconds,
      stats: {
        totalFiles: allObjects.length,
        privateFiles: privateFilesCount,
        sandboxFiles: sandboxObjects.length,
        totalBytes,
        activeTemporaryLinks: activeLinksCount,
        totalTrackedLinks: trackedPresignedLinks.length,
      },
      categoryBreakdown,
    });
  });

  // ---------------------------------------------------------------------------
  // 2. List Objects with Category Prefix & Search Filtering
  // ---------------------------------------------------------------------------
  app.get('/api/storage/objects', (req: Request, res: Response) => {
    const categoryFilter = String(req.query.category || 'all').toLowerCase();
    const searchQuery = String(req.query.search || '').trim().toLowerCase();
    const includeSandbox = req.query.includeSandbox !== 'false';

    const records: StoredObjectRecord[] = [
      ...Array.from(buckets[S3_CONFIG.privateBucket].values()),
      ...(includeSandbox ? Array.from(buckets[S3_CONFIG.publicDemoBucket].values()) : []),
    ];

    const filtered = records.filter((obj) => {
      if (categoryFilter !== 'all' && obj.category !== categoryFilter) {
        return false;
      }
      if (searchQuery) {
        const inKey = obj.key.toLowerCase().includes(searchQuery);
        const inFilename = obj.filename.toLowerCase().includes(searchQuery);
        const inMeta = Object.entries(obj.metadata).some(
          ([k, v]) =>
            `${k}=${v}`.toLowerCase().includes(searchQuery) ||
            v.toLowerCase().includes(searchQuery)
        );
        const inTags = Object.entries(obj.tags).some(
          ([k, v]) =>
            `${k}=${v}`.toLowerCase().includes(searchQuery) ||
            `${k}: ${v}`.toLowerCase().includes(searchQuery) ||
            v.toLowerCase().includes(searchQuery)
        );
        return inKey || inFilename || inMeta || inTags;
      }
      return true;
    });

    res.json({
      objects: filtered.map(serializeObject),
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Upload Categorized Object with Custom Metadata and Tags
  // ---------------------------------------------------------------------------
  app.post('/api/storage/upload', (req: Request, res: Response) => {
    try {
      const {
        filename,
        category = 'documents',
        contentType = 'application/octet-stream',
        contentBase64,
        metadata = {},
        tags = {},
        usePublicDemoBucket = false,
      } = req.body;

      const cleanFilename = sanitizeFilename(filename);
      const normalizedCategory = sanitizeCategoryPrefix(String(category));

      if (usePublicDemoBucket && !publicDemoModeEnabled) {
        res.status(403).json({
          error:
            'Public-read demonstration mode must be explicitly confirmed and enabled in Access & Security before uploading to the isolated sandbox bucket.',
        });
        return;
      }

      const targetBucket = usePublicDemoBucket
        ? S3_CONFIG.publicDemoBucket
        : S3_CONFIG.privateBucket;

      const bodyBuffer = Buffer.from(contentBase64 || '', 'base64');
      const key = `${normalizedCategory}/${cleanFilename}`;
      const etag = crypto.createHash('md5').update(bodyBuffer).digest('hex');

      const cleanMetadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(metadata || {})) {
        if (k && v !== undefined && String(v).trim()) {
          cleanMetadata[k.trim().toLowerCase().replace(/\s+/g, '-')] = String(v).trim();
        }
      }

      const cleanTags: Record<string, string> = {};
      for (const [k, v] of Object.entries(tags || {})) {
        if (k && v !== undefined && String(v).trim()) {
          cleanTags[k.trim()] = String(v).trim();
        }
      }
      if (Object.keys(cleanTags).length === 0) {
        cleanTags.Category =
          normalizedCategory.charAt(0).toUpperCase() + normalizedCategory.slice(1);
      }

      const record: StoredObjectRecord = {
        key,
        filename: cleanFilename,
        category: normalizedCategory,
        bucket: targetBucket,
        contentType: contentType || 'application/octet-stream',
        sizeBytes: bodyBuffer.length,
        lastModified: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        etag,
        body: bodyBuffer,
        metadata: cleanMetadata,
        tags: cleanTags,
      };

      buckets[targetBucket].set(key, record);
      res.status(201).json({
        message: `Uploaded '${cleanFilename}' to '${normalizedCategory}/' (${
          usePublicDemoBucket ? 'Isolated Sandbox' : 'Private Vault'
        }).`,
        object: serializeObject(record),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Upload failed.' });
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Update Object Tags & Metadata
  // ---------------------------------------------------------------------------
  app.put('/api/storage/tags', (req: Request, res: Response) => {
    const { bucket = S3_CONFIG.privateBucket, key, tags, metadata } = req.body;
    const bucketMap = buckets[bucket];
    if (!bucketMap || !bucketMap.has(key)) {
      res.status(404).json({ error: `Object '${key}' not found in bucket '${bucket}'.` });
      return;
    }

    const record = bucketMap.get(key)!;
    if (tags && typeof tags === 'object') {
      const updatedTags: Record<string, string> = {};
      for (const [k, v] of Object.entries(tags)) {
        if (k.trim() && String(v).trim()) {
          updatedTags[k.trim()] = String(v).trim();
        }
      }
      record.tags = updatedTags;
    }

    if (metadata && typeof metadata === 'object') {
      const updatedMeta: Record<string, string> = {};
      for (const [k, v] of Object.entries(metadata)) {
        if (k.trim() && String(v).trim()) {
          updatedMeta[k.trim().toLowerCase()] = String(v).trim();
        }
      }
      record.metadata = updatedMeta;
    }

    res.json({
      message: `Saved metadata and tags for '${record.filename}'.`,
      object: serializeObject(record),
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Authorized Download (Server-Side Credentialed Stream)
  // ---------------------------------------------------------------------------
  app.get('/api/storage/download', (req: Request, res: Response) => {
    const bucket = String(req.query.bucket || S3_CONFIG.privateBucket);
    const key = String(req.query.key || '');
    const bucketMap = buckets[bucket];
    if (!bucketMap || !bucketMap.has(key)) {
      res.status(404).json({ error: `NoSuchKey: The specified key '${key}' does not exist.` });
      return;
    }
    const record = bucketMap.get(key)!;
    res.setHeader('Content-Type', record.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${record.filename}"`);
    res.setHeader('ETag', `"${record.etag}"`);
    res.send(record.body);
  });

  // ---------------------------------------------------------------------------
  // 6. Delete Object (Requires Explicit Confirmation)
  // ---------------------------------------------------------------------------
  app.delete('/api/storage/object', (req: Request, res: Response) => {
    const { bucket = S3_CONFIG.privateBucket, key, confirmed } = req.body;
    if (!confirmed) {
      res.status(400).json({
        error: 'Explicit confirmation is required before deleting a file.',
      });
      return;
    }
    const bucketMap = buckets[bucket];
    if (!bucketMap || !bucketMap.has(key)) {
      res.status(404).json({ error: `NoSuchKey: Object '${key}' does not exist.` });
      return;
    }
    const filename = bucketMap.get(key)!.filename;
    bucketMap.delete(key);

    // Also remove tracked links for deleted object
    for (let i = trackedPresignedLinks.length - 1; i >= 0; i--) {
      if (
        trackedPresignedLinks[i].bucket === bucket &&
        trackedPresignedLinks[i].objectKey === key
      ) {
        trackedPresignedLinks.splice(i, 1);
      }
    }

    res.json({ message: `Deleted '${filename}' permanently.`, deleted: true });
  });

  // ---------------------------------------------------------------------------
  // 7. Toggle Isolated Public-Read Sandbox Demonstration Mode
  // ---------------------------------------------------------------------------
  app.post('/api/storage/public-demo', (req: Request, res: Response) => {
    const { enabled, explicitConfirmation } = req.body;
    if (enabled && !explicitConfirmation) {
      res.status(403).json({
        error:
          'Explicit confirmation is required before enabling public-read demonstration mode on the isolated sandbox bucket.',
      });
      return;
    }
    publicDemoModeEnabled = Boolean(enabled);
    res.json({
      publicDemoModeEnabled,
      publicDemoBucket: S3_CONFIG.publicDemoBucket,
      privateBucket: S3_CONFIG.privateBucket,
      privateBucketRemainsProtected: true,
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Update Default Settings
  // ---------------------------------------------------------------------------
  app.put('/api/storage/settings', (req: Request, res: Response) => {
    const { defaultPresignedExpiration } = req.body;
    const parsed = Number(defaultPresignedExpiration);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 604800) {
      res.status(400).json({
        error: 'Default expiration must be between 1 and 604800 seconds.',
      });
      return;
    }
    defaultExpirationSeconds = parsed;
    res.json({
      message: `Updated default temporary link expiration to ${parsed} seconds.`,
      defaultPresignedExpiration: defaultExpirationSeconds,
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Generate & Track Pre-Signed URLs (HMAC-SHA256 / AWS Signature V4)
  // ---------------------------------------------------------------------------
  app.get('/api/storage/presigned-links', (_req: Request, res: Response) => {
    const nowMs = Date.now();
    const links = trackedPresignedLinks.map((item) => ({
      ...item,
      isExpired: nowMs > item.expiresMs,
      remainingSeconds: Math.max(0, Math.ceil((item.expiresMs - nowMs) / 1000)),
    }));
    res.json({ links });
  });

  app.post('/api/storage/presign', (req: Request, res: Response) => {
    const {
      bucket = S3_CONFIG.privateBucket,
      key,
      expirationSeconds = defaultExpirationSeconds,
      backdateSeconds = 0,
    } = req.body;

    const bucketMap = buckets[bucket];
    if (!bucketMap || !bucketMap.has(key)) {
      res.status(404).json({ error: `NoSuchKey: Cannot pre-sign missing object '${key}'.` });
      return;
    }

    const record = bucketMap.get(key)!;
    const expiry = Number(expirationSeconds);
    if (!Number.isFinite(expiry) || expiry < 1 || expiry > 604800) {
      res.status(400).json({ error: 'Expiration must be between 1 and 604800 seconds.' });
      return;
    }

    const issuedMs = Date.now() - Number(backdateSeconds || 0) * 1000;
    const expiresMs = issuedMs + expiry * 1000;
    const issuedDate = new Date(issuedMs);
    const amzDate = issuedDate
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
    const datestamp = amzDate.slice(0, 8);
    const credential = `${S3_CONFIG.accessKey}/${datestamp}/${S3_CONFIG.region}/s3/aws4_request`;

    const signature = signPresignedParams(
      bucket,
      key,
      amzDate,
      expiry,
      issuedMs,
      credential
    );

    const params = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': credential,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiry),
      'X-Amz-Issued-Ms': String(issuedMs),
      'X-Amz-SignedHeaders': 'host',
      'X-Amz-Signature': signature,
    });

    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const relativeUrl = `/s3/${encodeURIComponent(bucket)}/${encodedKey}?${params.toString()}`;
    const directAnonymousUrl = `/s3/${encodeURIComponent(bucket)}/${encodedKey}`;

    const linkEntry: TrackedPresignedLink = {
      id: crypto.randomUUID(),
      url: relativeUrl,
      directAnonymousUrl,
      bucket,
      objectKey: key,
      filename: record.filename,
      category: record.category,
      expirationSeconds: expiry,
      issuedAt: issuedDate.toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      issuedMs,
      expiresMs,
      objectRemainsPrivate: bucket === S3_CONFIG.privateBucket,
    };

    trackedPresignedLinks.unshift(linkEntry);
    if (trackedPresignedLinks.length > 25) {
      trackedPresignedLinks.pop();
    }

    res.json(linkEntry);
  });

  // ---------------------------------------------------------------------------
  // 10. Raw S3 Object Endpoint (/s3/:bucket/*) Enforcing Private & Pre-Signed Rules
  // ---------------------------------------------------------------------------
  app.get('/s3/:bucket/*', (req: Request, res: Response) => {
    const bucket = req.params.bucket;
    const key = (req.params as Record<string, string>)[0] || '';
    const bucketMap = buckets[bucket];

    if (!bucketMap) {
      res.status(404).json({
        Error: {
          Code: 'NoSuchBucket',
          Message: `The specified bucket '${bucket}' does not exist.`,
        },
      });
      return;
    }

    const hasSignature = typeof req.query['X-Amz-Signature'] === 'string';

    if (hasSignature) {
      const amzDate = String(req.query['X-Amz-Date'] || '');
      const expiresSeconds = Number(req.query['X-Amz-Expires'] || 0);
      const issuedMs = Number(req.query['X-Amz-Issued-Ms'] || 0);
      const credential = String(req.query['X-Amz-Credential'] || '');
      const providedSig = String(req.query['X-Amz-Signature'] || '');

      if (
        !amzDate ||
        !expiresSeconds ||
        !issuedMs ||
        !credential.startsWith(`${S3_CONFIG.accessKey}/`)
      ) {
        res.status(403).json({
          Error: {
            Code: 'AuthorizationQueryParametersError',
            Message: 'Incomplete or malformed AWS Signature V4 query parameters.',
          },
        });
        return;
      }

      const expectedSig = signPresignedParams(
        bucket,
        key,
        amzDate,
        expiresSeconds,
        issuedMs,
        credential
      );

      if (providedSig !== expectedSig) {
        res.status(403).json({
          Error: {
            Code: 'SignatureDoesNotMatch',
            Message:
              'The request signature we calculated does not match the signature you provided.',
          },
        });
        return;
      }

      if (Date.now() > issuedMs + expiresSeconds * 1000) {
        res.status(403).json({
          Error: {
            Code: 'RequestHasExpired',
            Message: 'Request has expired. Pre-signed URL TTL has elapsed.',
            ExpiresAt: new Date(issuedMs + expiresSeconds * 1000).toISOString(),
          },
        });
        return;
      }
    } else {
      const isAllowedPublicSandbox =
        bucket === S3_CONFIG.publicDemoBucket && publicDemoModeEnabled;
      if (!isAllowedPublicSandbox) {
        res.status(403).json({
          Error: {
            Code: 'AccessDenied',
            Message:
              'Access Denied. File is private by default. Authenticate or generate a temporary pre-signed link.',
            Bucket: bucket,
            Key: key,
          },
        });
        return;
      }
    }

    if (!bucketMap.has(key)) {
      res.status(404).json({
        Error: {
          Code: 'NoSuchKey',
          Message: `The specified key '${key}' does not exist.`,
        },
      });
      return;
    }

    const record = bucketMap.get(key)!;
    res.setHeader('Content-Type', record.contentType);
    res.setHeader('ETag', `"${record.etag}"`);
    for (const [mk, mv] of Object.entries(record.metadata)) {
      res.setHeader(`x-amz-meta-${mk}`, mv);
    }
    res.send(record.body);
  });

  // ---------------------------------------------------------------------------
  // 11. Execute Live Python Automated Test Suite
  // ---------------------------------------------------------------------------
  app.post('/api/tests/run', (_req: Request, res: Response) => {
    const startTime = Date.now();
    execFile(
      process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      ['-m', 'unittest', 'discover', '-s', 'tests', '-v'],
      { cwd: __dirname, timeout: 60000 },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime;
        const combinedOutput = `${stdout}\n${stderr}`.trim();
        const lines = combinedOutput.split('\n');
        const parsedTests: Array<{
          name: string;
          suite: string;
          description: string;
          status: 'PASS' | 'FAIL';
        }> = [];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          const match = line.match(/^(test_\w+)\s+\(([^)]+)\)/);
          if (match) {
            const fnName = match[1];
            const suiteName = match[2];
            const nextLine = (lines[i + 1] || '').trim();
            const isPass =
              line.endsWith('... ok') || nextLine.endsWith('... ok');
            const desc = nextLine
              .replace(/\s*\.\.\.\s*(ok|ERROR|FAIL).*$/i, '')
              .trim();
            parsedTests.push({
              name: fnName,
              suite: suiteName,
              description: desc || fnName,
              status: isPass ? 'PASS' : 'FAIL',
            });
          }
        }

        const passedCount = parsedTests.filter((t) => t.status === 'PASS').length;
        const failedCount = parsedTests.length - passedCount;

        res.json({
          passed: !error && failedCount === 0,
          durationMs,
          totalTests: parsedTests.length,
          passedCount,
          failedCount,
          tests: parsedTests,
          rawOutput: combinedOutput,
        });
      }
    );
  });

  // ---------------------------------------------------------------------------
  // 12. Inspect Python Project Files
  // ---------------------------------------------------------------------------
  app.get('/api/project-files', (_req: Request, res: Response) => {
    const filePaths = [
      'app.py',
      'config.py',
      'docker-compose.yml',
      'README.md',
      'requirements.txt',
      'storage_manager.py',
      'tests/test_security.py',
      'tests/test_storage_manager.py',
    ];

    const files = filePaths.map((relPath) => {
      const absPath = path.join(__dirname, relPath);
      const content = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf-8') : '';
      return {
        path: relPath,
        name: relPath,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
        content,
      };
    });

    res.json({ files });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cloud Storage Organizer running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
