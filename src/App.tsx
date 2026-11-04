import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  Cloud,
  LayoutDashboard,
  FolderOpen,
  FileText,
  Image as ImageIcon,
  BarChart3,
  Briefcase,
  Link2,
  ShieldCheck,
  FlaskConical,
  Settings,
  Search,
  Bell,
  Upload,
  Download,
  Trash2,
  Copy,
  Check,
  Grid,
  List,
  ChevronRight,
  ChevronLeft,
  Plus,
  X,
  Lock,
  Unlock,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  ExternalLink,
  RefreshCw,
  ArrowUpDown,
  FileSpreadsheet,
  FileCode,
  File,
  Sparkles,
  Info,
  Play,
  Eye,
} from 'lucide-react';

type NavSection =
  | 'overview'
  | 'my-files'
  | 'documents'
  | 'images'
  | 'reports'
  | 'projects'
  | 'shared-links'
  | 'security'
  | 'tests'
  | 'settings';

interface StoredObject {
  key: string;
  filename: string;
  category: string;
  bucket: string;
  contentType: string;
  sizeBytes: number;
  lastModified: string;
  etag: string;
  accessMode: string;
  metadata: Record<string, string>;
  tags: Record<string, string>;
}

interface StorageStatus {
  connected: boolean;
  service: string;
  endpointUrl: string;
  region: string;
  privateBucket: string;
  publicDemoBucket: string;
  publicDemoModeEnabled: boolean;
  defaultPresignedExpiration: number;
  stats: {
    totalFiles: number;
    privateFiles: number;
    sandboxFiles: number;
    totalBytes: number;
    activeTemporaryLinks: number;
    totalTrackedLinks: number;
  };
  categoryBreakdown: Record<string, { count: number; bytes: number }>;
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
  isExpired?: boolean;
  remainingSeconds?: number;
}

interface AccessProbeResult {
  targetType: string;
  url: string;
  httpStatus: number;
  statusText: string;
  allowed: boolean;
  responsePreview: string;
  timestamp: string;
}

interface TestRunResponse {
  passed: boolean;
  durationMs: number;
  totalTests: number;
  passedCount: number;
  failedCount: number;
  tests: Array<{
    name: string;
    suite: string;
    description: string;
    status: 'PASS' | 'FAIL';
  }>;
  rawOutput: string;
}

interface ProjectFile {
  path: string;
  name: string;
  sizeBytes: number;
  content: string;
}

interface ActivityToast {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  message: string;
  time: string;
}

const TAG_PILL_STYLES = [
  'bg-indigo-50 text-indigo-700 border-indigo-200',
  'bg-teal-50 text-teal-700 border-teal-200',
  'bg-amber-50 text-amber-800 border-amber-200',
  'bg-violet-50 text-violet-700 border-violet-200',
  'bg-sky-50 text-sky-700 border-sky-200',
  'bg-rose-50 text-rose-700 border-rose-200',
];

function getTagPillStyle(index: number): string {
  return TAG_PILL_STYLES[index % TAG_PILL_STYLES.length];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRelativeOrShortDate(iso: string): string {
  if (!iso) return 'Just now';
  return iso.replace('T', ' ').replace('Z', ' UTC');
}

function getFileVisuals(filename: string, contentType: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf') || contentType.includes('pdf')) {
    return {
      label: 'PDF Document',
      ext: 'PDF',
      icon: FileText,
      bg: 'bg-rose-50',
      text: 'text-rose-600',
      border: 'border-rose-200',
    };
  }
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.webp') ||
    contentType.includes('image')
  ) {
    return {
      label: 'Image Graphic',
      ext: lower.split('.').pop()?.toUpperCase() || 'IMG',
      icon: ImageIcon,
      bg: 'bg-violet-50',
      text: 'text-violet-600',
      border: 'border-violet-200',
    };
  }
  if (lower.endsWith('.csv') || lower.endsWith('.xlsx') || contentType.includes('csv')) {
    return {
      label: 'CSV Dataset',
      ext: 'CSV',
      icon: FileSpreadsheet,
      bg: 'bg-teal-50',
      text: 'text-teal-600',
      border: 'border-teal-200',
    };
  }
  if (lower.endsWith('.json') || lower.endsWith('.xml') || contentType.includes('json')) {
    return {
      label: 'JSON Config',
      ext: 'JSON',
      icon: FileCode,
      bg: 'bg-amber-50',
      text: 'text-amber-600',
      border: 'border-amber-200',
    };
  }
  return {
    label: 'Text / Document',
    ext: lower.split('.').pop()?.toUpperCase() || 'TXT',
    icon: File,
    bg: 'bg-sky-50',
    text: 'text-sky-600',
    border: 'border-sky-200',
  };
}

export default function App() {
  const [activeNav, setActiveNav] = useState<NavSection>('overview');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);

  // Real Backend State
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [allObjects, setAllObjects] = useState<StoredObject[]>([]);
  const [trackedLinks, setTrackedLinks] = useState<TrackedPresignedLink[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Explorer View & Filters
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortBy, setSortBy] = useState<'name' | 'date' | 'size' | 'type'>('date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Selected File for Details Drawer
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [selectedBucket, setSelectedBucket] = useState<string>('');
  const [detailsOpen, setDetailsOpen] = useState<boolean>(true);

  // Editable Metadata & Tags in Details Panel
  const [editDepartment, setEditDepartment] = useState<string>('');
  const [editOwner, setEditOwner] = useState<string>('');
  const [editDescription, setEditDescription] = useState<string>('');
  const [editTags, setEditTags] = useState<Array<{ key: string; value: string }>>([]);
  const [newTagInput, setNewTagInput] = useState<string>('');
  const [savingMeta, setSavingMeta] = useState<boolean>(false);

  // Upload Modal State
  const [uploadModalOpen, setUploadModalOpen] = useState<boolean>(false);
  const [uploadQueue, setUploadQueue] = useState<File[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);
  const [uploadCategoryChoice, setUploadCategoryChoice] = useState<string>('documents');
  const [customCategoryName, setCustomCategoryName] = useState<string>('archives');
  const [uploadDepartment, setUploadDepartment] = useState<string>('IT');
  const [uploadOwner, setUploadOwner] = useState<string>('Cloud Team');
  const [uploadDescription, setUploadDescription] = useState<string>('');
  const [uploadTags, setUploadTags] = useState<Array<{ key: string; value: string }>>([
    { key: 'Category', value: 'Academic' },
    { key: 'Type', value: 'Report' },
  ]);
  const [uploadTagDraft, setUploadTagDraft] = useState<string>('');
  const [uploadToSandbox, setUploadToSandbox] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Delete Confirmation Modal State
  const [deleteTarget, setDeleteTarget] = useState<StoredObject | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  // Public Sandbox Confirmation Modal State
  const [sandboxModalOpen, setSandboxModalOpen] = useState<boolean>(false);
  const [sandboxConfirmChecked, setSandboxConfirmChecked] = useState<boolean>(false);

  // Shared & Temporary Links State
  const [shareSelectedFile, setShareSelectedFile] = useState<string>('');
  const [shareExpirationSeconds, setShareExpirationSeconds] = useState<number>(300);
  const [latestGeneratedLink, setLatestGeneratedLink] =
    useState<TrackedPresignedLink | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string>('');
  const [probeResult, setProbeResult] = useState<AccessProbeResult | null>(null);
  const [nowTick, setNowTick] = useState<number>(Date.now());

  // Automated Tests State
  const [testResult, setTestResult] = useState<TestRunResponse | null>(null);
  const [runningTests, setRunningTests] = useState<boolean>(false);

  // Settings & Project Source Files State
  const [defaultExpirySetting, setDefaultExpirySetting] = useState<number>(300);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [selectedSourceIdx, setSelectedSourceIdx] = useState<number>(0);
  const [copiedSource, setCopiedSource] = useState<boolean>(false);

  // Toasts & Activity Feed
  const [toasts, setToasts] = useState<ActivityToast[]>([]);
  const [activityLog, setActivityLog] = useState<ActivityToast[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState<boolean>(false);

  const pushToast = useCallback(
    (type: 'success' | 'error' | 'info', title: string, message: string) => {
      const entry: ActivityToast = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        title,
        message,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setToasts((prev) => [entry, ...prev.slice(0, 3)]);
      setActivityLog((prev) => [entry, ...prev.slice(0, 14)]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== entry.id));
      }, 4500);
    },
    []
  );

  // Load storage status, objects, and tracked temporary links
  const refreshAll = useCallback(async () => {
    try {
      const [statusRes, objsRes, linksRes] = await Promise.all([
        fetch('/api/storage/status'),
        fetch('/api/storage/objects?category=all'),
        fetch('/api/storage/presigned-links'),
      ]);
      const statusData: StorageStatus = await statusRes.json();
      const objsData: { objects: StoredObject[] } = await objsRes.json();
      const linksData: { links: TrackedPresignedLink[] } = await linksRes.json();

      setStatus(statusData);
      setDefaultExpirySetting(statusData.defaultPresignedExpiration);
      const list = objsData.objects || [];
      setAllObjects(list);
      setTrackedLinks(linksData.links || []);

      if (list.length > 0) {
        const currentExists = list.find(
          (o) => o.key === selectedKey && o.bucket === selectedBucket
        );
        const target = currentExists || list[0];
        setSelectedKey(target.key);
        setSelectedBucket(target.bucket);
        if (!shareSelectedFile) {
          setShareSelectedFile(`${target.bucket}::${target.key}`);
        }
      } else {
        setSelectedKey('');
        setSelectedBucket('');
        setShareSelectedFile('');
      }
    } catch (err: any) {
      pushToast('error', 'Connection Error', err.message || 'Unable to reach storage API.');
    } finally {
      setLoading(false);
    }
  }, [selectedKey, selectedBucket, shareSelectedFile, pushToast]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // 1-second ticker for live pre-signed link countdowns
  useEffect(() => {
    const timer = setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Sync sidebar category navigation with categoryFilter
  const handleSelectNav = (section: NavSection) => {
    setActiveNav(section);
    if (section === 'documents') setCategoryFilter('documents');
    else if (section === 'images') setCategoryFilter('images');
    else if (section === 'reports') setCategoryFilter('reports');
    else if (section === 'projects') setCategoryFilter('projects');
    else if (section === 'my-files') setCategoryFilter('all');
  };

  // Active selected object
  const activeObject = useMemo(
    () =>
      allObjects.find((o) => o.key === selectedKey && o.bucket === selectedBucket) ||
      null,
    [allObjects, selectedKey, selectedBucket]
  );

  // Sync Details Panel editors when activeObject changes
  useEffect(() => {
    if (activeObject) {
      setEditDepartment(activeObject.metadata.department || '');
      setEditOwner(activeObject.metadata.owner || '');
      setEditDescription(activeObject.metadata.description || '');
      const tagPairs = Object.entries(activeObject.tags).map(([key, value]) => ({
        key,
        value,
      }));
      setEditTags(tagPairs);
    }
  }, [activeObject?.key, activeObject?.bucket]);

  // Filtered and sorted objects for Explorer
  const displayedObjects = useMemo(() => {
    const effectiveCategory =
      activeNav === 'documents'
        ? 'documents'
        : activeNav === 'images'
        ? 'images'
        : activeNav === 'reports'
        ? 'reports'
        : activeNav === 'projects'
        ? 'projects'
        : categoryFilter;

    const q = searchQuery.trim().toLowerCase();

    const filtered = allObjects.filter((obj) => {
      if (effectiveCategory !== 'all' && obj.category !== effectiveCategory) {
        return false;
      }
      if (q) {
        const matchFilename = obj.filename.toLowerCase().includes(q);
        const matchKey = obj.key.toLowerCase().includes(q);
        const matchMeta = Object.values(obj.metadata).some((v) =>
          v.toLowerCase().includes(q)
        );
        const matchTag = Object.entries(obj.tags).some(
          ([k, v]) =>
            `${k}:${v}`.toLowerCase().includes(q) ||
            `${k}=${v}`.toLowerCase().includes(q) ||
            v.toLowerCase().includes(q)
        );
        return matchFilename || matchKey || matchMeta || matchTag;
      }
      return true;
    });

    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'name') {
        cmp = a.filename.localeCompare(b.filename);
      } else if (sortBy === 'size') {
        cmp = a.sizeBytes - b.sizeBytes;
      } else if (sortBy === 'type') {
        cmp = a.contentType.localeCompare(b.contentType);
      } else {
        cmp = a.lastModified.localeCompare(b.lastModified);
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });

    return sorted;
  }, [allObjects, activeNav, categoryFilter, searchQuery, sortBy, sortOrder]);

  // Count currently active (non-expired) tracked links dynamically
  const activeLinksCount = useMemo(
    () => trackedLinks.filter((l) => l.expiresMs > nowTick).length,
    [trackedLinks, nowTick]
  );

  // Load project files when Settings is opened
  useEffect(() => {
    if (activeNav === 'settings' && projectFiles.length === 0) {
      fetch('/api/project-files')
        .then((r) => r.json())
        .then((data) => {
          if (data.files) setProjectFiles(data.files);
        })
        .catch(() => {});
    }
  }, [activeNav, projectFiles.length]);

  // Auto-run test suite on first visit to Automated Tests tab
  const handleRunTests = useCallback(async () => {
    setRunningTests(true);
    try {
      const res = await fetch('/api/tests/run', { method: 'POST' });
      const data: TestRunResponse = await res.json();
      setTestResult(data);
      pushToast(
        data.passed ? 'success' : 'error',
        data.passed ? 'Test Suite Passed' : 'Test Suite Alert',
        `Executed ${data.totalTests} automated Python tests in ${data.durationMs}ms.`
      );
    } catch (err: any) {
      pushToast('error', 'Test Runner Error', err.message || 'Could not run tests.');
    } finally {
      setRunningTests(false);
    }
  }, [pushToast]);

  useEffect(() => {
    if (activeNav === 'tests' && !testResult && !runningTests) {
      handleRunTests();
    }
  }, [activeNav, testResult, runningTests, handleRunTests]);

  // Multi-file or single-file upload handler
  const executeUploadFiles = async (filesToUpload: File[]) => {
    if (filesToUpload.length === 0) {
      pushToast('error', 'No File Selected', 'Please choose at least one file to upload.');
      return;
    }

    const targetCategory =
      uploadCategoryChoice === 'custom'
        ? customCategoryName.trim() || 'custom'
        : uploadCategoryChoice;

    setIsUploading(true);
    setUploadProgress(10);

    try {
      const tagsObj: Record<string, string> = {};
      uploadTags.forEach((t) => {
        if (t.key.trim() && t.value.trim()) {
          tagsObj[t.key.trim()] = t.value.trim();
        }
      });

      let lastUploaded: StoredObject | null = null;

      for (let idx = 0; idx < filesToUpload.length; idx++) {
        const file = filesToUpload[idx];
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const contentBase64 = btoa(binary);

        const res = await fetch('/api/storage/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            category: targetCategory,
            contentType: file.type || 'application/octet-stream',
            contentBase64,
            metadata: {
              department: uploadDepartment || 'General',
              owner: uploadOwner || 'Team Member',
              description: uploadDescription || `Uploaded to ${targetCategory}/`,
            },
            tags: tagsObj,
            usePublicDemoBucket: uploadToSandbox,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Failed to upload ${file.name}`);
        }
        lastUploaded = data.object;
        setUploadProgress(Math.round(((idx + 1) / filesToUpload.length) * 100));
      }

      pushToast(
        'success',
        'Upload Complete',
        `Successfully uploaded ${filesToUpload.length} file${
          filesToUpload.length > 1 ? 's' : ''
        } to '${targetCategory}/'.`
      );
      setUploadQueue([]);
      setUploadModalOpen(false);
      if (lastUploaded) {
        setSelectedKey(lastUploaded.key);
        setSelectedBucket(lastUploaded.bucket);
        setDetailsOpen(true);
      }
      await refreshAll();
    } catch (err: any) {
      pushToast('error', 'Upload Failed', err.message || 'Could not upload file.');
    } finally {
      setTimeout(() => {
        setIsUploading(false);
        setUploadProgress(0);
      }, 300);
    }
  };

  // Handle Drag & Drop onto Explorer or Modal
  const handleDropFiles = async (
    e: React.DragEvent<HTMLDivElement>,
    autoUploadImmediately = false
  ) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const dropped = Array.from(e.dataTransfer.files || []);
    if (dropped.length === 0) return;

    if (autoUploadImmediately) {
      setUploadQueue(dropped);
      setUploadModalOpen(true);
    } else {
      setUploadQueue((prev) => [...prev, ...dropped]);
    }
  };

  // Add sample starter file into upload queue for instant testing
  const addStarterFileToQueue = (
    filename: string,
    category: string,
    mime: string,
    content: string
  ) => {
    const blob = new Blob([content], { type: mime });
    const file = new globalThis.File([blob], filename, { type: mime });
    setUploadQueue((prev) => [...prev, file]);
    setUploadCategoryChoice(category);
  };

  // Save edited metadata and tags on activeObject
  const handleSaveMetadataAndTags = async (
    overrideTags?: Array<{ key: string; value: string }>
  ) => {
    if (!activeObject) return;
    setSavingMeta(true);
    try {
      const listToSave = overrideTags || editTags;
      const tagsPayload: Record<string, string> = {};
      listToSave.forEach((item) => {
        if (item.key.trim() && item.value.trim()) {
          tagsPayload[item.key.trim()] = item.value.trim();
        }
      });

      const res = await fetch('/api/storage/tags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket: activeObject.bucket,
          key: activeObject.key,
          tags: tagsPayload,
          metadata: {
            department: editDepartment,
            owner: editOwner,
            description: editDescription,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save metadata and tags.');
      }
      pushToast('success', 'Details Saved', data.message);
      await refreshAll();
    } catch (err: any) {
      pushToast('error', 'Save Failed', err.message);
    } finally {
      setSavingMeta(false);
    }
  };

  const handleAddTagToActiveObject = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = newTagInput.trim();
    if (!raw || !activeObject) return;

    let key = 'Tag';
    let value = raw;
    if (raw.includes(':')) {
      const parts = raw.split(':');
      key = parts[0].trim() || 'Tag';
      value = parts.slice(1).join(':').trim();
    } else if (raw.includes('=')) {
      const parts = raw.split('=');
      key = parts[0].trim() || 'Tag';
      value = parts.slice(1).join('=').trim();
    } else {
      key = raw;
      value = 'Tagged';
    }

    const updated = [...editTags.filter((t) => t.key !== key), { key, value }];
    setEditTags(updated);
    setNewTagInput('');
    await handleSaveMetadataAndTags(updated);
  };

  const handleRemoveTagFromActiveObject = async (keyToRemove: string) => {
    const updated = editTags.filter((t) => t.key !== keyToRemove);
    setEditTags(updated);
    await handleSaveMetadataAndTags(updated);
  };

  // Confirm and execute object deletion
  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const res = await fetch('/api/storage/object', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket: deleteTarget.bucket,
          key: deleteTarget.key,
          confirmed: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Delete failed.');
      }
      pushToast('success', 'File Deleted', data.message);
      setDeleteTarget(null);
      await refreshAll();
    } catch (err: any) {
      pushToast('error', 'Delete Error', err.message);
    } finally {
      setIsDeleting(false);
    }
  };

  // Generate Pre-Signed URL
  const handleGenerateTemporaryLink = async (backdateSeconds = 0) => {
    const targetValue =
      shareSelectedFile ||
      (activeObject ? `${activeObject.bucket}::${activeObject.key}` : '');
    if (!targetValue) {
      pushToast('error', 'Select a File', 'Please choose a file to share first.');
      return;
    }
    const [bucket, key] = targetValue.split('::');
    try {
      const res = await fetch('/api/storage/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket,
          key,
          expirationSeconds: shareExpirationSeconds,
          backdateSeconds,
        }),
      });
      const data: TrackedPresignedLink = await res.json();
      if (!res.ok) {
        throw new Error((data as any).error || 'Could not generate link.');
      }
      setLatestGeneratedLink(data);
      setProbeResult(null);
      pushToast(
        'success',
        backdateSeconds > 0 ? 'Expired Test Link Created' : 'Secure Temporary Link Created',
        `Generated pre-signed URL for '${data.filename}' (${data.expirationSeconds}s expiration).`
      );
      await refreshAll();
    } catch (err: any) {
      pushToast('error', 'Link Error', err.message);
    }
  };

  // Probe URL Access (Pre-Signed vs Anonymous Direct URL)
  const handleTestUrlAccess = async (
    urlToFetch: string,
    label: string
  ) => {
    try {
      const res = await fetch(urlToFetch);
      const bodyText = await res.text();
      setProbeResult({
        targetType: label,
        url: new URL(urlToFetch, window.location.origin).toString(),
        httpStatus: res.status,
        statusText:
          res.status === 200
            ? '200 OK — Authorized Download Verified'
            : '403 Forbidden — Access Denied',
        allowed: res.ok,
        responsePreview: bodyText.slice(0, 500),
        timestamp: new Date().toLocaleTimeString(),
      });
      pushToast(
        res.ok ? 'success' : 'info',
        res.ok ? 'Access Granted (HTTP 200)' : 'Access Blocked (HTTP 403)',
        `${label} returned HTTP ${res.status}.`
      );
    } catch (err: any) {
      pushToast('error', 'Verification Error', err.message);
    }
  };

  // Toggle Isolated Public-Read Sandbox
  const handleToggleSandboxMode = async (enable: boolean) => {
    try {
      const res = await fetch('/api/storage/public-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: enable,
          explicitConfirmation: enable ? sandboxConfirmChecked : true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Could not update sandbox mode.');
      }
      setSandboxModalOpen(false);
      setSandboxConfirmChecked(false);
      pushToast(
        'info',
        enable ? 'Isolated Public Demo Enabled' : 'Public Demo Disabled',
        enable
          ? `Sandbox bucket '${data.publicDemoBucket}' is now public-read. Main vault '${data.privateBucket}' remains strictly private.`
          : `Sandbox bucket '${data.publicDemoBucket}' returned to private mode.`
      );
      await refreshAll();
    } catch (err: any) {
      pushToast('error', 'Security Policy Error', err.message);
    }
  };

  const navItems: Array<{
    id: NavSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }> = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    {
      id: 'my-files',
      label: 'My Files',
      icon: FolderOpen,
      badge: status?.stats.totalFiles,
    },
    {
      id: 'documents',
      label: 'Documents',
      icon: FileText,
      badge: status?.categoryBreakdown?.documents?.count,
    },
    {
      id: 'images',
      label: 'Images',
      icon: ImageIcon,
      badge: status?.categoryBreakdown?.images?.count,
    },
    {
      id: 'reports',
      label: 'Reports',
      icon: BarChart3,
      badge: status?.categoryBreakdown?.reports?.count,
    },
    {
      id: 'projects',
      label: 'Projects',
      icon: Briefcase,
      badge: status?.categoryBreakdown?.projects?.count,
    },
    {
      id: 'shared-links',
      label: 'Shared & Temporary Links',
      icon: Link2,
      badge: activeLinksCount || undefined,
    },
    { id: 'security', label: 'Access & Security', icon: ShieldCheck },
    { id: 'tests', label: 'Automated Tests', icon: FlaskConical },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const currentSectionTitle =
    navItems.find((i) => i.id === activeNav)?.label || 'Overview';

  const isExplorerView =
    activeNav === 'my-files' ||
    activeNav === 'documents' ||
    activeNav === 'images' ||
    activeNav === 'reports' ||
    activeNav === 'projects';

  return (
    <div className="min-h-screen flex bg-[#f6f5ff] text-slate-900">
      {/* LEFT COLLAPSIBLE SIDEBAR */}
      <aside
        className={`${
          sidebarCollapsed ? 'w-20' : 'w-68'
        } transition-all duration-200 bg-white border-r border-indigo-100 flex flex-col justify-between shrink-0 select-none z-20`}
      >
        {/* Top Brand & Menu */}
        <div className="p-4 space-y-6">
          <div className="flex items-center justify-between gap-2 px-1">
            <button
              type="button"
              onClick={() => handleSelectNav('overview')}
              className="flex items-center gap-3 text-left focus:outline-hidden"
            >
              <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-sm shrink-0">
                <Cloud className="w-5 h-5" />
              </div>
              {!sidebarCollapsed && (
                <div>
                  <div className="font-display font-bold text-base text-slate-900 leading-tight">
                    Cloud Organizer
                  </div>
                  <div className="text-[11px] font-medium text-indigo-600">
                    Storage & Access Control
                  </div>
                </div>
              )}
            </button>
            <button
              type="button"
              onClick={() => setSidebarCollapsed((c) => !c)}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            >
              {sidebarCollapsed ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronLeft className="w-4 h-4" />
              )}
            </button>
          </div>

          {/* Navigation Items */}
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeNav === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelectNav(item.id)}
                  title={sidebarCollapsed ? item.label : undefined}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-600 hover:bg-indigo-50/70 hover:text-indigo-950'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        isActive ? 'text-white' : 'text-indigo-500'
                      }`}
                    />
                    {!sidebarCollapsed && (
                      <span className="truncate">{item.label}</span>
                    )}
                  </div>
                  {!sidebarCollapsed && item.badge !== undefined && (
                    <span
                      className={`text-xs font-mono tabular-nums px-2 py-0.5 rounded-md ${
                        isActive
                          ? 'bg-indigo-700 text-indigo-100'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom Compact Storage Status & Help Section */}
        <div className="p-4 space-y-3 border-t border-indigo-50">
          <div className={`p-3 rounded-xl ${status?.connected ? 'bg-teal-50/70 border border-teal-200/80' : 'bg-rose-50/70 border border-rose-200/80'}`}>
            <div className="flex items-center gap-2">
              {status?.connected ? <CheckCircle2 className="w-4 h-4 text-teal-600 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />}
              {!sidebarCollapsed && (
                <div className="min-w-0">
                  <div className={`text-xs font-semibold ${status?.connected ? 'text-teal-950' : 'text-rose-950'} truncate`}>
                    {status?.connected ? 'S3 / MinIO Connected' : status ? 'Storage Offline' : 'Connecting...'}
                  </div>
                  <div className={`text-[11px] ${status?.connected ? 'text-teal-700' : 'text-rose-700'} truncate font-mono tabular-nums`}>
                    {status ? formatBytes(status.stats.totalBytes) : '0 B'} used ·{' '}
                    {status ? status.stats.totalFiles : 0} files
                  </div>
                </div>
              )}
            </div>
          </div>

          {!sidebarCollapsed && (
            <div className="p-3 rounded-xl bg-indigo-50/60 border border-indigo-100 text-xs text-slate-600 space-y-1.5">
              <div className="flex items-center gap-1.5 font-semibold text-indigo-950">
                <HelpCircle className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                <span>Quick Beginner Tip</span>
              </div>
              <p className="leading-relaxed text-[11px] text-slate-600">
                Every file you upload is locked in your private vault by default. Use{' '}
                <button
                  type="button"
                  onClick={() => handleSelectNav('shared-links')}
                  className="text-indigo-600 font-semibold underline"
                >
                  Temporary Links
                </button>{' '}
                to share safely.
              </p>
            </div>
          )}
        </div>
      </aside>

      {/* MAIN CONTENT VIEWPORT */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* TOP NAVIGATION BAR */}
        <header className="sticky top-0 z-10 bg-white/95 backdrop-blur-xs border-b border-indigo-100 px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
          {/* Left: Breadcrumb Location */}
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => handleSelectNav('overview')}
              className="text-slate-500 hover:text-indigo-600 font-medium transition-colors"
            >
              Cloud Organizer
            </button>
            <ChevronRight className="w-4 h-4 text-slate-400" />
            <span className="font-semibold text-slate-900">
              {currentSectionTitle}
            </span>
            {isExplorerView && categoryFilter !== 'all' && activeNav === 'my-files' && (
              <>
                <ChevronRight className="w-4 h-4 text-slate-400" />
                <span className="font-mono text-xs font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md">
                  {categoryFilter}/
                </span>
              </>
            )}
          </div>

          {/* Center/Right: Search Input, Connection Badge, Notifications, Upload Button */}
          <div className="flex items-center gap-3 flex-1 sm:flex-initial justify-end">
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (!isExplorerView && e.target.value.trim()) {
                    setActiveNav('my-files');
                  }
                }}
                placeholder="Search your files..."
                className="w-full pl-10 pr-8 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-hidden focus:bg-white focus:border-indigo-500 transition-colors"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Storage Connection Indicator */}
            <div
              title={`Connected to ${status?.endpointUrl || 'local S3 storage'} (${
                status?.privateBucket || 'cloud-organizer-private'
              })`}
              className={`hidden md:flex items-center gap-1.5 px-3 py-2 rounded-xl ${status?.connected ? 'bg-teal-50 text-teal-800 border border-teal-200' : 'bg-rose-50 text-rose-800 border border-rose-200'} text-xs font-semibold whitespace-nowrap shrink-0`}
            >
              {status?.connected ? <CheckCircle2 className="w-3.5 h-3.5 text-teal-600" /> : <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />}
              <span>{status?.connected ? 'Storage Connected' : status ? 'Storage Offline' : 'Checking storage'}</span>
            </div>

            {/* Activity Notifications Bell */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setNotificationsOpen((o) => !o)}
                title="Recent storage activity"
                className="p-2.5 rounded-xl bg-slate-50 hover:bg-indigo-50 text-slate-600 hover:text-indigo-600 border border-slate-200 transition-colors relative"
              >
                <Bell className="w-4 h-4" />
                {activityLog.length > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center">
                    {Math.min(9, activityLog.length)}
                  </span>
                )}
              </button>

              {notificationsOpen && (
                <div className="absolute right-0 mt-2 w-80 bg-white rounded-2xl shadow-lg border border-indigo-100 p-4 z-30 space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <span className="text-xs font-bold text-slate-900">
                      Recent Activity
                    </span>
                    <button
                      type="button"
                      onClick={() => setNotificationsOpen(false)}
                      className="text-xs text-slate-400 hover:text-slate-600"
                    >
                      Close
                    </button>
                  </div>
                  {activityLog.length === 0 ? (
                    <p className="text-xs text-slate-500 py-4 text-center">
                      Upload a file or generate a secure link to see activity here.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {activityLog.map((item) => (
                        <div
                          key={item.id}
                          className="p-2.5 rounded-xl bg-slate-50 text-xs space-y-0.5"
                        >
                          <div className="flex items-center justify-between font-semibold text-slate-900">
                            <span>{item.title}</span>
                            <span className="text-[10px] text-slate-400 font-mono">
                              {item.time}
                            </span>
                          </div>
                          <p className="text-slate-600 leading-snug">{item.message}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Prominent Colorful Upload Files Button */}
            <button
              type="button"
              onClick={() => setUploadModalOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm shadow-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              <span>Upload Files</span>
            </button>
          </div>
        </header>

        {/* FLOATING TOAST NOTIFICATIONS */}
        {toasts.length > 0 && (
          <div className="fixed bottom-5 right-5 z-50 space-y-2 max-w-sm w-full pointer-events-none">
            {toasts.map((toast) => (
              <div
                key={toast.id}
                className={`pointer-events-auto flex items-start justify-between gap-3 p-4 rounded-2xl shadow-lg border bg-white ${
                  toast.type === 'error'
                    ? 'border-rose-200'
                    : toast.type === 'success'
                    ? 'border-teal-200'
                    : 'border-indigo-200'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  {toast.type === 'error' ? (
                    <XCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                  ) : toast.type === 'success' ? (
                    <CheckCircle2 className="w-5 h-5 text-teal-600 shrink-0 mt-0.5" />
                  ) : (
                    <Info className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <div className="text-xs font-bold text-slate-900">
                      {toast.title}
                    </div>
                    <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                      {toast.message}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setToasts((prev) => prev.filter((t) => t.id !== toast.id))
                  }
                  className="text-slate-400 hover:text-slate-600"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* PAGE BODY */}
        <main className="flex-1 p-6 max-w-[1440px] w-full mx-auto space-y-6">
          {/* ===============================================================
              PAGE 1: OVERVIEW DASHBOARD
          =============================================================== */}
          {activeNav === 'overview' && (
            <div className="space-y-6">
              {/* Friendly Welcome Banner */}
              <section className="bg-white rounded-2xl border border-indigo-100 p-6 sm:p-8 shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                <div className="space-y-2 max-w-2xl">
                  <div className="inline-flex items-center gap-2 text-xs font-semibold text-indigo-600">
                    <Sparkles className="w-4 h-4" />
                    <span>Cloud Storage & Access Control Workspace</span>
                  </div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight font-display">
                    Your files. Organized. Secure. Always accessible.
                  </h1>
                  <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
                    Manage your cloud files, organize documents, control access, and share
                    files securely.
                  </p>
                </div>

                {/* Quick Actions Cluster */}
                <div className="grid grid-cols-2 gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={() => setUploadModalOpen(true)}
                    className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-colors"
                  >
                    <Upload className="w-4 h-4 shrink-0" />
                    <span>Upload File</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectNav('my-files')}
                    className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-violet-50 hover:bg-violet-100 text-violet-900 border border-violet-200 text-xs font-semibold transition-colors"
                  >
                    <FolderOpen className="w-4 h-4 text-violet-600 shrink-0" />
                    <span>Browse Files</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectNav('shared-links')}
                    className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-950 border border-amber-200 text-xs font-semibold transition-colors"
                  >
                    <Link2 className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>Generate Secure Link</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectNav('tests')}
                    className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-teal-50 hover:bg-teal-100 text-teal-950 border border-teal-200 text-xs font-semibold transition-colors"
                  >
                    <FlaskConical className="w-4 h-4 text-teal-600 shrink-0" />
                    <span>Run Security Tests</span>
                  </button>
                </div>
              </section>

              {/* 4 Pastel Summary Cards */}
              <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Card 1: Total Files */}
                <div className="bg-indigo-50/70 border border-indigo-200/80 rounded-2xl p-5 flex items-start justify-between">
                  <div>
                    <div className="text-xs font-semibold text-indigo-900">
                      Total Files
                    </div>
                    <div className="text-3xl font-bold text-slate-900 font-mono tabular-nums mt-2">
                      {status ? status.stats.totalFiles : 0}
                    </div>
                    <div className="text-xs text-indigo-700 mt-1">
                      Stored in S3 / MinIO buckets
                    </div>
                  </div>
                  <div className="w-11 h-11 rounded-xl bg-indigo-600 text-white flex items-center justify-center shrink-0">
                    <FolderOpen className="w-5 h-5" />
                  </div>
                </div>

                {/* Card 2: Storage Used */}
                <div className="bg-sky-50/70 border border-sky-200/80 rounded-2xl p-5 flex items-start justify-between">
                  <div>
                    <div className="text-xs font-semibold text-sky-900">
                      Storage Used
                    </div>
                    <div className="text-3xl font-bold text-slate-900 font-mono tabular-nums mt-2">
                      {status ? formatBytes(status.stats.totalBytes) : '0 B'}
                    </div>
                    <div className="text-xs text-sky-700 mt-1">
                      Calculated from live object sizes
                    </div>
                  </div>
                  <div className="w-11 h-11 rounded-xl bg-sky-600 text-white flex items-center justify-center shrink-0">
                    <Cloud className="w-5 h-5" />
                  </div>
                </div>

                {/* Card 3: Private Files */}
                <div className="bg-teal-50/70 border border-teal-200/80 rounded-2xl p-5 flex items-start justify-between">
                  <div>
                    <div className="text-xs font-semibold text-teal-900">
                      Private Files
                    </div>
                    <div className="text-3xl font-bold text-slate-900 font-mono tabular-nums mt-2">
                      {status ? status.stats.privateFiles : 0}
                    </div>
                    <div className="text-xs text-teal-700 mt-1">
                      Protected against anonymous access
                    </div>
                  </div>
                  <div className="w-11 h-11 rounded-xl bg-teal-600 text-white flex items-center justify-center shrink-0">
                    <Lock className="w-5 h-5" />
                  </div>
                </div>

                {/* Card 4: Active Temporary Links */}
                <div className="bg-amber-50/80 border border-amber-200/90 rounded-2xl p-5 flex items-start justify-between">
                  <div>
                    <div className="text-xs font-semibold text-amber-950">
                      Active Temporary Links
                    </div>
                    <div className="text-3xl font-bold text-slate-900 font-mono tabular-nums mt-2">
                      {activeLinksCount}
                    </div>
                    <div className="text-xs text-amber-800 mt-1">
                      Time-limited pre-signed URLs
                    </div>
                  </div>
                  <div className="w-11 h-11 rounded-xl bg-amber-500 text-white flex items-center justify-center shrink-0">
                    <Clock className="w-5 h-5" />
                  </div>
                </div>
              </section>

              {/* Colorful File-Category Section */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">
                      Browse by Category
                    </h2>
                    <p className="text-xs text-slate-600">
                      Files are organized automatically using S3 folder prefixes.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSelectNav('my-files')}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1"
                  >
                    <span>View All Files</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    {
                      id: 'documents' as NavSection,
                      key: 'documents',
                      title: 'Documents',
                      prefix: 'documents/',
                      desc: 'PDFs, policies, guides & handbooks',
                      icon: FileText,
                      cardBg: 'bg-white hover:border-indigo-300',
                      iconBg: 'bg-indigo-100 text-indigo-600',
                    },
                    {
                      id: 'images' as NavSection,
                      key: 'images',
                      title: 'Images',
                      prefix: 'images/',
                      desc: 'Diagrams, PNGs, SVGs & visual assets',
                      icon: ImageIcon,
                      cardBg: 'bg-white hover:border-violet-300',
                      iconBg: 'bg-violet-100 text-violet-600',
                    },
                    {
                      id: 'reports' as NavSection,
                      key: 'reports',
                      title: 'Reports',
                      prefix: 'reports/',
                      desc: 'CSV datasets, audits & analytics',
                      icon: BarChart3,
                      cardBg: 'bg-white hover:border-teal-300',
                      iconBg: 'bg-teal-100 text-teal-600',
                    },
                    {
                      id: 'projects' as NavSection,
                      key: 'projects',
                      title: 'Projects',
                      prefix: 'projects/',
                      desc: 'JSON manifests, code & deliverables',
                      icon: Briefcase,
                      cardBg: 'bg-white hover:border-amber-300',
                      iconBg: 'bg-amber-100 text-amber-700',
                    },
                  ].map((cat) => {
                    const Icon = cat.icon;
                    const stat = status?.categoryBreakdown?.[cat.key] || {
                      count: 0,
                      bytes: 0,
                    };
                    return (
                      <button
                        key={cat.key}
                        type="button"
                        onClick={() => handleSelectNav(cat.id)}
                        className={`text-left p-5 rounded-2xl border border-indigo-100 shadow-2xs transition-all cursor-pointer ${cat.cardBg}`}
                      >
                        <div className="flex items-center justify-between">
                          <div
                            className={`w-10 h-10 rounded-xl flex items-center justify-center ${cat.iconBg}`}
                          >
                            <Icon className="w-5 h-5" />
                          </div>
                          <span className="text-xs font-mono text-slate-400">
                            {cat.prefix}
                          </span>
                        </div>
                        <div className="mt-4 font-bold text-base text-slate-900">
                          {cat.title}
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">{cat.desc}</p>
                        <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs font-mono tabular-nums text-slate-700">
                          <span>{stat.count} files</span>
                          <span>{formatBytes(stat.bytes)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Recent Files + Storage Connection Card */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                {/* Recent Files Table (8 cols) */}
                <section className="lg:col-span-8 bg-white rounded-2xl border border-indigo-100 p-6 shadow-2xs space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-base font-bold text-slate-900">
                        Recent Files
                      </h2>
                      <p className="text-xs text-slate-500">
                        Click any file to view metadata, edit tags, download, or create a
                        temporary link.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSelectNav('my-files')}
                      className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
                    >
                      Open File Explorer
                    </button>
                  </div>

                  {allObjects.length === 0 ? (
                    <div className="py-12 text-center space-y-3 border border-dashed border-indigo-200 rounded-xl bg-indigo-50/30">
                      <FolderOpen className="w-8 h-8 text-indigo-400 mx-auto" />
                      <div className="text-sm font-semibold text-slate-800">
                        No files here yet. Upload your first file to get started.
                      </div>
                      <button
                        type="button"
                        onClick={() => setUploadModalOpen(true)}
                        className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700"
                      >
                        Upload Files
                      </button>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-100 text-slate-500 font-semibold">
                            <th className="py-2.5 pr-3">File Name</th>
                            <th className="py-2.5 px-3">Type</th>
                            <th className="py-2.5 px-3 text-right">Size</th>
                            <th className="py-2.5 px-3">Modified</th>
                            <th className="py-2.5 px-3">Access Status</th>
                            <th className="py-2.5 pl-3 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {allObjects.slice(0, 6).map((obj) => {
                            const vis = getFileVisuals(obj.filename, obj.contentType);
                            const Icon = vis.icon;
                            return (
                              <tr
                                key={`${obj.bucket}::${obj.key}`}
                                onClick={() => {
                                  setSelectedKey(obj.key);
                                  setSelectedBucket(obj.bucket);
                                  setDetailsOpen(true);
                                  handleSelectNav('my-files');
                                }}
                                className="hover:bg-indigo-50/40 transition-colors cursor-pointer"
                              >
                                <td className="py-3 pr-3">
                                  <div className="flex items-center gap-2.5">
                                    <div
                                      className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${vis.bg} ${vis.text}`}
                                    >
                                      <Icon className="w-4 h-4" />
                                    </div>
                                    <div>
                                      <div className="font-semibold text-slate-900">
                                        {obj.filename}
                                      </div>
                                      <div className="text-[11px] text-slate-500 font-mono">
                                        {obj.category}/
                                      </div>
                                    </div>
                                  </div>
                                </td>
                                <td className="py-3 px-3 text-slate-600 font-medium whitespace-nowrap">
                                  {vis.ext}
                                </td>
                                <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                                  {formatBytes(obj.sizeBytes)}
                                </td>
                                <td className="py-3 px-3 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                                  {formatRelativeOrShortDate(obj.lastModified)}
                                </td>
                                <td className="py-3 px-3 whitespace-nowrap">
                                  <span
                                    className={`inline-flex items-center gap-1 font-semibold ${
                                      obj.accessMode === 'Private'
                                        ? 'text-teal-700'
                                        : 'text-amber-700'
                                    }`}
                                  >
                                    {obj.accessMode === 'Private' ? (
                                      <Lock className="w-3.5 h-3.5" />
                                    ) : (
                                      <Unlock className="w-3.5 h-3.5" />
                                    )}
                                    <span>{obj.accessMode}</span>
                                  </span>
                                </td>
                                <td
                                  className="py-3 pl-3 text-right whitespace-nowrap"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <div className="inline-flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setShareSelectedFile(
                                          `${obj.bucket}::${obj.key}`
                                        );
                                        handleSelectNav('shared-links');
                                      }}
                                      title="Create temporary share link"
                                      className="p-1.5 rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-colors"
                                    >
                                      <Link2 className="w-3.5 h-3.5" />
                                    </button>
                                    <a
                                      href={`/api/storage/download?bucket=${encodeURIComponent(
                                        obj.bucket
                                      )}&key=${encodeURIComponent(obj.key)}`}
                                      download={obj.filename}
                                      title="Download file"
                                      className="p-1.5 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                    </a>
                                    <button
                                      type="button"
                                      onClick={() => setDeleteTarget(obj)}
                                      title="Delete file"
                                      className="p-1.5 rounded-lg bg-rose-50 text-rose-600 hover:bg-rose-100 transition-colors"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* Storage Connection & Security Summary Card (4 cols) */}
                <section className="lg:col-span-4 bg-white rounded-2xl border border-indigo-100 p-6 shadow-2xs space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-base font-bold text-slate-900">
                      Storage Connection
                    </h2>
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700 bg-teal-50 px-2.5 py-1 rounded-lg border border-teal-200">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Online</span>
                    </span>
                  </div>

                  <p className="text-xs text-slate-600 leading-relaxed">
                    Connected to your local S3-compatible object storage service. All
                    credentials remain safely on the backend server and are never exposed in
                    the browser.
                  </p>

                  <div className="space-y-2.5 pt-2 border-t border-slate-100 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Storage Engine</span>
                      <span className="font-semibold text-slate-900">
                        MinIO / S3v4 API
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Endpoint URL</span>
                      <span className="font-mono text-slate-800">
                        {status?.endpointUrl || 'http://localhost:9000'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Primary Vault Bucket</span>
                      <span className="font-mono font-semibold text-indigo-700">
                        {status?.privateBucket || 'cloud-organizer-private'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Default Access Policy</span>
                      <span className="font-semibold text-teal-700">
                        Private-by-Default
                      </span>
                    </div>
                  </div>

                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => handleSelectNav('security')}
                      className="w-full py-2.5 px-4 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-semibold text-xs transition-colors"
                    >
                      Open Access & Security Center
                    </button>
                  </div>
                </section>
              </div>
            </div>
          )}

          {/* ===============================================================
              PAGE 2: MY FILES / CATEGORY EXPLORER (GOOGLE DRIVE STYLE)
          =============================================================== */}
          {isExplorerView && (
            <div className="space-y-5">
              {/* Top Controls Bar: Category Pills, Sort & View Toggle */}
              <div className="bg-white rounded-2xl border border-indigo-100 p-4 shadow-2xs flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  {[
                    { id: 'all', label: 'All Files' },
                    { id: 'documents', label: 'Documents' },
                    { id: 'images', label: 'Images' },
                    { id: 'reports', label: 'Reports' },
                    { id: 'projects', label: 'Projects' },
                  ].map((tab) => {
                    const activeCat =
                      activeNav === 'my-files' ? categoryFilter : activeNav;
                    const isSelected = activeCat === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => {
                          if (tab.id === 'all') {
                            setActiveNav('my-files');
                            setCategoryFilter('all');
                          } else {
                            setActiveNav(tab.id as NavSection);
                            setCategoryFilter(tab.id);
                          }
                        }}
                        className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-indigo-600 text-white shadow-2xs'
                            : 'bg-slate-50 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700'
                        }`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-3">
                  {/* Sort Selector */}
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-slate-500">Sort by:</span>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as any)}
                      className="px-2.5 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-slate-800 font-medium"
                    >
                      <option value="date">Modified Date</option>
                      <option value="name">File Name</option>
                      <option value="size">File Size</option>
                      <option value="type">File Type</option>
                    </select>
                    <button
                      type="button"
                      onClick={() =>
                        setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
                      }
                      title="Toggle sort direction"
                      className="p-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700"
                    >
                      <ArrowUpDown className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Grid vs List View Toggle */}
                  <div className="flex items-center p-1 bg-slate-100 rounded-xl">
                    <button
                      type="button"
                      onClick={() => setViewMode('grid')}
                      title="Grid view"
                      className={`p-1.5 rounded-lg transition-colors ${
                        viewMode === 'grid'
                          ? 'bg-white text-indigo-600 shadow-2xs'
                          : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      <Grid className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('list')}
                      title="List view"
                      className={`p-1.5 rounded-lg transition-colors ${
                        viewMode === 'list'
                          ? 'bg-white text-indigo-600 shadow-2xs'
                          : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      <List className="w-4 h-4" />
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setDetailsOpen((d) => !d)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
                      detailsOpen
                        ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
                        : 'bg-white text-slate-600 border-slate-200'
                    }`}
                  >
                    {detailsOpen ? 'Hide Details' : 'Show Details'}
                  </button>
                </div>
              </div>

              {/* Prominent Drag and Drop Upload Bar */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDraggingOver(true);
                }}
                onDragLeave={() => setIsDraggingOver(false)}
                onDrop={(e) => handleDropFiles(e, true)}
                onClick={() => setUploadModalOpen(true)}
                className={`p-5 rounded-2xl border-2 border-dashed transition-all cursor-pointer flex flex-col sm:flex-row items-center justify-between gap-4 ${
                  isDraggingOver
                    ? 'border-indigo-600 bg-indigo-50/80'
                    : 'border-indigo-200 bg-white hover:border-indigo-400 hover:bg-indigo-50/30'
                }`}
              >
                <div className="flex items-center gap-3.5">
                  <div className="w-11 h-11 rounded-xl bg-indigo-100 text-indigo-600 flex items-center justify-center shrink-0">
                    <Upload className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-slate-900">
                      Drag and drop files here, or browse your computer.
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Supports PDFs, images, CSV datasets, text files, and JSON. Protected as
                      Private by default.
                    </p>
                  </div>
                </div>
                <span className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold whitespace-nowrap shrink-0">
                  Browse Computer
                </span>
              </div>

              {/* Main Explorer Grid/List + Side File Details Panel */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <div
                  className={
                    detailsOpen && activeObject ? 'lg:col-span-8' : 'lg:col-span-12'
                  }
                >
                  {displayedObjects.length === 0 ? (
                    <div className="bg-white rounded-2xl border border-indigo-100 p-12 text-center space-y-3">
                      <FolderOpen className="w-10 h-10 text-indigo-400 mx-auto" />
                      <h3 className="text-base font-bold text-slate-900">
                        No files here yet. Upload your first file to get started.
                      </h3>
                      <p className="text-xs text-slate-500 max-w-md mx-auto">
                        Drag and drop any file into the drop zone above or click Upload Files
                        to organize your cloud storage.
                      </p>
                      <button
                        type="button"
                        onClick={() => setUploadModalOpen(true)}
                        className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold"
                      >
                        Upload Your First File
                      </button>
                    </div>
                  ) : viewMode === 'grid' ? (
                    /* GOOGLE DRIVE STYLE GRID CARDS */
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                      {displayedObjects.map((obj) => {
                        const vis = getFileVisuals(obj.filename, obj.contentType);
                        const Icon = vis.icon;
                        const isSelected =
                          obj.key === selectedKey && obj.bucket === selectedBucket;
                        const tagList = Object.entries(obj.tags);

                        return (
                          <div
                            key={`${obj.bucket}::${obj.key}`}
                            onClick={() => {
                              setSelectedKey(obj.key);
                              setSelectedBucket(obj.bucket);
                              setDetailsOpen(true);
                            }}
                            className={`group bg-white rounded-2xl border p-4 transition-all cursor-pointer flex flex-col justify-between ${
                              isSelected
                                ? 'border-indigo-600 ring-2 ring-indigo-600/15 shadow-sm'
                                : 'border-indigo-100 hover:border-indigo-300 hover:shadow-xs'
                            }`}
                          >
                            <div>
                              {/* Card Top Row: File Type Icon + Access Status */}
                              <div className="flex items-start justify-between gap-2">
                                <div
                                  className={`w-11 h-11 rounded-xl flex items-center justify-center border ${vis.bg} ${vis.text} ${vis.border}`}
                                >
                                  <Icon className="w-5 h-5" />
                                </div>
                                <span
                                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold ${
                                    obj.accessMode === 'Private'
                                      ? 'bg-teal-50 text-teal-800 border border-teal-200'
                                      : 'bg-amber-50 text-amber-800 border border-amber-200'
                                  }`}
                                >
                                  {obj.accessMode === 'Private' ? (
                                    <Lock className="w-3 h-3" />
                                  ) : (
                                    <Unlock className="w-3 h-3" />
                                  )}
                                  <span>
                                    {obj.accessMode === 'Private' ? 'Private' : 'Sandbox'}
                                  </span>
                                </span>
                              </div>

                              {/* Filename & Prefix */}
                              <div className="mt-3.5">
                                <h3
                                  title={obj.filename}
                                  className="font-bold text-sm text-slate-900 truncate"
                                >
                                  {obj.filename}
                                </h3>
                                <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5 font-mono tabular-nums">
                                  <span>{obj.category}/</span>
                                  <span>·</span>
                                  <span>{formatBytes(obj.sizeBytes)}</span>
                                </div>
                              </div>

                              {/* Colorful Tag Pills */}
                              {tagList.length > 0 && (
                                <div className="mt-3 flex flex-wrap gap-1.5">
                                  {tagList.slice(0, 3).map(([k, v], i) => (
                                    <span
                                      key={k}
                                      className={`px-2 py-0.5 rounded-lg text-[11px] font-medium border ${getTagPillStyle(
                                        i
                                      )}`}
                                    >
                                      {k === 'Category' || k === 'Type'
                                        ? v
                                        : `${k}: ${v}`}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* Card Footer Actions */}
                            <div
                              className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span className="text-[11px] text-slate-400 font-mono tabular-nums">
                                {obj.lastModified.slice(0, 10)}
                              </span>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setShareSelectedFile(`${obj.bucket}::${obj.key}`);
                                    handleSelectNav('shared-links');
                                  }}
                                  title="Share temporary link"
                                  className="p-1.5 rounded-lg text-indigo-600 hover:bg-indigo-50 transition-colors"
                                >
                                  <Link2 className="w-4 h-4" />
                                </button>
                                <a
                                  href={`/api/storage/download?bucket=${encodeURIComponent(
                                    obj.bucket
                                  )}&key=${encodeURIComponent(obj.key)}`}
                                  download={obj.filename}
                                  title="Download file"
                                  className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
                                >
                                  <Download className="w-4 h-4" />
                                </a>
                                <button
                                  type="button"
                                  onClick={() => setDeleteTarget(obj)}
                                  title="Delete file"
                                  className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-50 transition-colors"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    /* LIST VIEW TABLE */
                    <div className="bg-white rounded-2xl border border-indigo-100 p-4 shadow-2xs overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-100 text-slate-500 font-semibold">
                            <th className="py-2.5 pr-3">File Name</th>
                            <th className="py-2.5 px-3">Folder Prefix</th>
                            <th className="py-2.5 px-3">Tags</th>
                            <th className="py-2.5 px-3 text-right">Size</th>
                            <th className="py-2.5 px-3">Access</th>
                            <th className="py-2.5 pl-3 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {displayedObjects.map((obj) => {
                            const vis = getFileVisuals(obj.filename, obj.contentType);
                            const Icon = vis.icon;
                            const isSelected =
                              obj.key === selectedKey && obj.bucket === selectedBucket;
                            return (
                              <tr
                                key={`${obj.bucket}::${obj.key}`}
                                onClick={() => {
                                  setSelectedKey(obj.key);
                                  setSelectedBucket(obj.bucket);
                                  setDetailsOpen(true);
                                }}
                                className={`cursor-pointer transition-colors ${
                                  isSelected
                                    ? 'bg-indigo-50/70'
                                    : 'hover:bg-slate-50'
                                }`}
                              >
                                <td className="py-3 pr-3">
                                  <div className="flex items-center gap-2.5">
                                    <div
                                      className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${vis.bg} ${vis.text}`}
                                    >
                                      <Icon className="w-4 h-4" />
                                    </div>
                                    <span className="font-semibold text-slate-900">
                                      {obj.filename}
                                    </span>
                                  </div>
                                </td>
                                <td className="py-3 px-3 font-mono text-slate-600">
                                  {obj.category}/
                                </td>
                                <td className="py-3 px-3">
                                  <div className="flex flex-wrap gap-1">
                                    {Object.entries(obj.tags).map(([k, v], i) => (
                                      <span
                                        key={k}
                                        className={`px-2 py-0.5 rounded-md text-[11px] font-medium border ${getTagPillStyle(
                                          i
                                        )}`}
                                      >
                                        {k === 'Category' || k === 'Type'
                                          ? v
                                          : `${k}: ${v}`}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                                <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700">
                                  {formatBytes(obj.sizeBytes)}
                                </td>
                                <td className="py-3 px-3">
                                  <span
                                    className={`inline-flex items-center gap-1 font-semibold ${
                                      obj.accessMode === 'Private'
                                        ? 'text-teal-700'
                                        : 'text-amber-700'
                                    }`}
                                  >
                                    {obj.accessMode === 'Private' ? (
                                      <Lock className="w-3.5 h-3.5" />
                                    ) : (
                                      <Unlock className="w-3.5 h-3.5" />
                                    )}
                                    <span>{obj.accessMode}</span>
                                  </span>
                                </td>
                                <td
                                  className="py-3 pl-3 text-right whitespace-nowrap"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <div className="inline-flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setShareSelectedFile(
                                          `${obj.bucket}::${obj.key}`
                                        );
                                        handleSelectNav('shared-links');
                                      }}
                                      className="px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium"
                                    >
                                      Share
                                    </button>
                                    <a
                                      href={`/api/storage/download?bucket=${encodeURIComponent(
                                        obj.bucket
                                      )}&key=${encodeURIComponent(obj.key)}`}
                                      download={obj.filename}
                                      className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 font-medium"
                                    >
                                      Download
                                    </a>
                                    <button
                                      type="button"
                                      onClick={() => setDeleteTarget(obj)}
                                      className="px-2.5 py-1 rounded-lg bg-rose-50 text-rose-600 hover:bg-rose-100 font-medium"
                                    >
                                      Delete
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* FILE DETAILS, METADATA & COLORFUL TAGS PANEL */}
                {detailsOpen && activeObject && (
                  <aside className="lg:col-span-4 bg-white rounded-2xl border border-indigo-100 p-5 shadow-2xs space-y-5">
                    <div className="flex items-start justify-between gap-2 pb-3 border-b border-slate-100">
                      <div className="min-w-0">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-indigo-600">
                          File Details
                        </span>
                        <h3 className="text-base font-bold text-slate-900 truncate mt-0.5">
                          {activeObject.filename}
                        </h3>
                        <p className="text-xs font-mono text-slate-500 truncate">
                          {activeObject.key}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDetailsOpen(false)}
                        className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Quick Properties Grid */}
                    <div className="grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-slate-50 text-xs">
                      <div>
                        <div className="text-slate-400">Size</div>
                        <div className="font-semibold font-mono tabular-nums text-slate-800 mt-0.5">
                          {formatBytes(activeObject.sizeBytes)}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-400">Folder Prefix</div>
                        <div className="font-semibold font-mono text-slate-800 mt-0.5">
                          {activeObject.category}/
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-400">Access Status</div>
                        <div className="font-semibold text-teal-700 mt-0.5 flex items-center gap-1">
                          <Lock className="w-3 h-3" />
                          <span>{activeObject.accessMode}</span>
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-400">Bucket</div>
                        <div className="font-mono text-slate-700 truncate mt-0.5">
                          {activeObject.bucket}
                        </div>
                      </div>
                    </div>

                    {/* Colorful Editable Tag Pills */}
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-bold text-slate-900">
                          Object Tags
                        </label>
                        <span className="text-[11px] text-slate-400">
                          Click × to remove
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {editTags.length === 0 ? (
                          <span className="text-xs text-slate-400">
                            No tags attached yet.
                          </span>
                        ) : (
                          editTags.map((tag, idx) => (
                            <span
                              key={tag.key}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border ${getTagPillStyle(
                                idx
                              )}`}
                            >
                              <span>
                                {tag.key === 'Category' || tag.key === 'Type'
                                  ? tag.value
                                  : `${tag.key}: ${tag.value}`}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleRemoveTagFromActiveObject(tag.key)}
                                className="hover:opacity-75"
                                title={`Remove tag ${tag.key}`}
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </span>
                          ))
                        )}
                      </div>

                      <form
                        onSubmit={handleAddTagToActiveObject}
                        className="flex items-center gap-2 pt-1"
                      >
                        <input
                          type="text"
                          value={newTagInput}
                          onChange={(e) => setNewTagInput(e.target.value)}
                          placeholder="Add tag (e.g. Academic or Department: IT)"
                          className="flex-1 px-3 py-1.5 text-xs border border-slate-200 rounded-xl focus:outline-hidden focus:border-indigo-500"
                        />
                        <button
                          type="submit"
                          className="px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold inline-flex items-center gap-1 shrink-0"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Add</span>
                        </button>
                      </form>
                    </div>

                    {/* Editable Metadata Fields */}
                    <div className="space-y-3 pt-3 border-t border-slate-100">
                      <div className="text-xs font-bold text-slate-900">
                        Custom Metadata
                      </div>
                      <div className="grid grid-cols-2 gap-2.5">
                        <div>
                          <label className="block text-[11px] font-medium text-slate-500 mb-1">
                            Department
                          </label>
                          <input
                            type="text"
                            value={editDepartment}
                            onChange={(e) => setEditDepartment(e.target.value)}
                            className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-xl"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-slate-500 mb-1">
                            Owner
                          </label>
                          <input
                            type="text"
                            value={editOwner}
                            onChange={(e) => setEditOwner(e.target.value)}
                            className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-xl"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-slate-500 mb-1">
                          Description
                        </label>
                        <input
                          type="text"
                          value={editDescription}
                          onChange={(e) => setEditDescription(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-xl"
                        />
                      </div>

                      <button
                        type="button"
                        disabled={savingMeta}
                        onClick={() => handleSaveMetadataAndTags()}
                        className="w-full py-2 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition-colors cursor-pointer"
                      >
                        {savingMeta ? 'Saving Changes...' : 'Save Metadata & Tags'}
                      </button>
                    </div>

                    {/* Primary File Actions */}
                    <div className="pt-3 border-t border-slate-100 grid grid-cols-2 gap-2.5">
                      <a
                        href={`/api/storage/download?bucket=${encodeURIComponent(
                          activeObject.bucket
                        )}&key=${encodeURIComponent(activeObject.key)}`}
                        download={activeObject.filename}
                        className="py-2 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download</span>
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          setShareSelectedFile(
                            `${activeObject.bucket}::${activeObject.key}`
                          );
                          handleSelectNav('shared-links');
                        }}
                        className="py-2 px-3 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors"
                      >
                        <Link2 className="w-3.5 h-3.5 text-amber-600" />
                        <span>Share Link</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => setDeleteTarget(activeObject)}
                      className="w-full py-2 px-3 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete File...</span>
                    </button>
                  </aside>
                )}
              </div>
            </div>
          )}

          {/* ===============================================================
              PAGE 3: SHARED & TEMPORARY LINKS (PRE-SIGNED URLS)
          =============================================================== */}
          {activeNav === 'shared-links' && (
            <div className="space-y-6">
              <section className="bg-white rounded-2xl border border-indigo-100 p-6 sm:p-8 shadow-2xs space-y-6">
                <div className="max-w-2xl space-y-1.5">
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-50 px-3 py-1 rounded-lg border border-amber-200">
                    <Clock className="w-3.5 h-3.5" />
                    <span>Time-Limited Pre-Signed URLs</span>
                  </div>
                  <h1 className="text-2xl font-bold text-slate-900 font-display">
                    Shared & Temporary Links
                  </h1>
                  <p className="text-sm text-slate-600">
                    Share a private file through a temporary link without making the file
                    public.
                  </p>
                </div>

                {/* Generator Controls */}
                <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end p-5 rounded-2xl bg-slate-50 border border-slate-200/80">
                  <div className="md:col-span-6">
                    <label className="block text-xs font-bold text-slate-700 mb-1.5">
                      1. Select a Private File to Share
                    </label>
                    <select
                      value={shareSelectedFile}
                      onChange={(e) => setShareSelectedFile(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-xs border border-slate-300 rounded-xl bg-white font-medium text-slate-900"
                    >
                      {allObjects.map((o) => (
                        <option
                          key={`${o.bucket}::${o.key}`}
                          value={`${o.bucket}::${o.key}`}
                        >
                          {o.filename} ({o.category}/ · {formatBytes(o.sizeBytes)})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="md:col-span-3">
                    <label className="block text-xs font-bold text-slate-700 mb-1.5">
                      2. Choose Expiration Time
                    </label>
                    <select
                      value={shareExpirationSeconds}
                      onChange={(e) => setShareExpirationSeconds(Number(e.target.value))}
                      className="w-full px-3.5 py-2.5 text-xs border border-slate-300 rounded-xl bg-white font-medium text-slate-900"
                    >
                      <option value={60}>60 seconds</option>
                      <option value={300}>5 minutes</option>
                      <option value={900}>15 minutes</option>
                    </select>
                  </div>

                  <div className="md:col-span-3">
                    <button
                      type="button"
                      onClick={() => handleGenerateTemporaryLink(0)}
                      className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs shadow-xs transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Link2 className="w-4 h-4" />
                      <span>Generate Secure Link</span>
                    </button>
                  </div>
                </div>

                {/* Friendly Beginner Security Notice */}
                <div className="p-4 rounded-xl bg-sky-50/80 border border-sky-200 flex items-start gap-3 text-xs text-sky-950">
                  <Info className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
                  <div className="space-y-1 leading-relaxed">
                    <span className="font-bold">How temporary sharing works:</span>{' '}
                    Anyone possessing a valid pre-signed URL may access and download the
                    selected file until the expiration timer reaches zero. Generating a link
                    never makes your bucket or file public, and once expired, the storage
                    server automatically blocks the link.
                  </div>
                </div>

                {/* Latest Generated Link Card */}
                {latestGeneratedLink && (
                  <div className="p-5 rounded-2xl bg-indigo-950 text-white space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-indigo-200">
                        Generated Pre-Signed Link for {latestGeneratedLink.filename}
                      </span>
                      <span className="font-mono tabular-nums px-2.5 py-1 rounded-lg bg-indigo-900 text-teal-300">
                        Expires at {formatRelativeOrShortDate(latestGeneratedLink.expiresAt)}
                      </span>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-900 font-mono text-xs text-indigo-100 break-all">
                      {latestGeneratedLink.url}
                    </div>
                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(latestGeneratedLink.url);
                          setCopiedLinkId(latestGeneratedLink.id);
                          setTimeout(() => setCopiedLinkId(''), 2000);
                        }}
                        className="px-3.5 py-2 rounded-xl bg-white text-slate-900 hover:bg-indigo-50 text-xs font-semibold inline-flex items-center gap-1.5"
                      >
                        {copiedLinkId === latestGeneratedLink.id ? (
                          <Check className="w-3.5 h-3.5 text-teal-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>
                          {copiedLinkId === latestGeneratedLink.id
                            ? 'Copied to Clipboard!'
                            : 'Copy Link'}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          handleTestUrlAccess(
                            latestGeneratedLink.url,
                            `Pre-Signed Link (${latestGeneratedLink.filename})`
                          )
                        }
                        className="px-3.5 py-2 rounded-xl bg-teal-500 hover:bg-teal-400 text-slate-950 text-xs font-bold inline-flex items-center gap-1.5"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>Test Link Access Now</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleGenerateTemporaryLink(shareExpirationSeconds + 60)}
                        className="px-3 py-2 rounded-xl bg-indigo-900 hover:bg-indigo-800 text-indigo-200 text-xs font-medium"
                      >
                        Simulate Expired Link Test
                      </button>
                    </div>
                  </div>
                )}

                {/* Live Probe Verification Output */}
                {probeResult && (
                  <div
                    className={`p-4 rounded-2xl border space-y-2 ${
                      probeResult.allowed
                        ? 'bg-teal-50/70 border-teal-200'
                        : 'bg-rose-50/70 border-rose-200'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-900">
                        Verification Result: {probeResult.targetType}
                      </span>
                      <span
                        className={`font-mono font-bold ${
                          probeResult.allowed ? 'text-teal-700' : 'text-rose-700'
                        }`}
                      >
                        {probeResult.statusText}
                      </span>
                    </div>
                    <pre className="p-3 rounded-xl bg-white border border-slate-200 text-xs font-mono text-slate-700 overflow-x-auto whitespace-pre-wrap">
                      {probeResult.responsePreview}
                    </pre>
                  </div>
                )}
              </section>

              {/* Tracked Temporary Links Table */}
              <section className="bg-white rounded-2xl border border-indigo-100 p-6 shadow-2xs space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-bold text-slate-900">
                      Tracked Temporary Links ({trackedLinks.length})
                    </h2>
                    <p className="text-xs text-slate-500">
                      Real pre-signed URLs generated during this session with live expiration
                      countdowns.
                    </p>
                  </div>
                </div>

                {trackedLinks.length === 0 ? (
                  <p className="text-xs text-slate-500 py-8 text-center">
                    No temporary links generated yet. Select a file above and click Generate
                    Secure Link.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-100 text-slate-500 font-semibold">
                          <th className="py-2.5 pr-3">File Name</th>
                          <th className="py-2.5 px-3">Duration</th>
                          <th className="py-2.5 px-3">Expires At</th>
                          <th className="py-2.5 px-3">Countdown Status</th>
                          <th className="py-2.5 pl-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {trackedLinks.map((link) => {
                          const remSec = Math.max(
                            0,
                            Math.ceil((link.expiresMs - nowTick) / 1000)
                          );
                          const isExpired = remSec <= 0;
                          return (
                            <tr key={link.id}>
                              <td className="py-3 pr-3 font-semibold text-slate-900">
                                {link.filename}
                                <span className="block text-[11px] font-mono text-slate-400">
                                  {link.objectKey}
                                </span>
                              </td>
                              <td className="py-3 px-3 font-mono tabular-nums text-slate-600">
                                {link.expirationSeconds}s
                              </td>
                              <td className="py-3 px-3 font-mono tabular-nums text-slate-600">
                                {formatRelativeOrShortDate(link.expiresAt)}
                              </td>
                              <td className="py-3 px-3">
                                <span
                                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-mono font-semibold tabular-nums ${
                                    isExpired
                                      ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                      : 'bg-teal-50 text-teal-700 border border-teal-200'
                                  }`}
                                >
                                  <Clock className="w-3 h-3" />
                                  <span>
                                    {isExpired ? 'Expired' : `${remSec}s remaining`}
                                  </span>
                                </span>
                              </td>
                              <td className="py-3 pl-3 text-right whitespace-nowrap space-x-1.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    navigator.clipboard.writeText(link.url);
                                    setCopiedLinkId(link.id);
                                    setTimeout(() => setCopiedLinkId(''), 2000);
                                  }}
                                  className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium"
                                >
                                  {copiedLinkId === link.id ? 'Copied' : 'Copy Link'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleTestUrlAccess(
                                      link.url,
                                      `Pre-Signed URL (${link.filename})`
                                    )
                                  }
                                  className="px-2.5 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-medium"
                                >
                                  Test Link
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          )}

          {/* ===============================================================
              PAGE 4: ACCESS & SECURITY CENTER
          =============================================================== */}
          {activeNav === 'security' && (
            <div className="space-y-6">
              <section className="bg-white rounded-2xl border border-indigo-100 p-6 sm:p-8 shadow-2xs space-y-6">
                <div className="space-y-1.5">
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-700 bg-teal-50 px-3 py-1 rounded-lg border border-teal-200">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Zero-Trust Cloud Storage Posture</span>
                  </div>
                  <h1 className="text-2xl font-bold text-slate-900 font-display">
                    Access & Security Center
                  </h1>
                  <p className="text-sm text-slate-600">
                    Real-time verification of your bucket protection, anonymous access blocks,
                    and temporary sharing controls.
                  </p>
                </div>

                {/* Security Status Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-5 rounded-2xl bg-teal-50/70 border border-teal-200 space-y-2">
                    <div className="flex items-center justify-between">
                      <span
                        title="Every newly uploaded file is private by default and cannot be read without credentials or a valid pre-signed signature."
                        className="text-xs font-bold text-teal-950 underline decoration-dotted cursor-help"
                      >
                        Private-by-Default Status
                      </span>
                      <CheckCircle2 className="w-5 h-5 text-teal-600" />
                    </div>
                    <div className="text-lg font-bold text-teal-900">
                      Active & Verified
                    </div>
                    <p className="text-xs text-teal-800 leading-relaxed">
                      All uploads go to{' '}
                      <code className="font-mono font-semibold">
                        {status?.privateBucket}
                      </code>{' '}
                      with public access disabled.
                    </p>
                  </div>

                  <div className="p-5 rounded-2xl bg-teal-50/70 border border-teal-200 space-y-2">
                    <div className="flex items-center justify-between">
                      <span
                        title="Unauthenticated visitors trying to guess or open direct file URLs receive HTTP 403 AccessDenied."
                        className="text-xs font-bold text-teal-950 underline decoration-dotted cursor-help"
                      >
                        Anonymous Access Status
                      </span>
                      <Lock className="w-5 h-5 text-teal-600" />
                    </div>
                    <div className="text-lg font-bold text-teal-900">
                      Blocked (HTTP 403)
                    </div>
                    <p className="text-xs text-teal-800 leading-relaxed">
                      Direct unauthenticated requests to private objects are rejected
                      immediately.
                    </p>
                  </div>

                  <div
                    className={`p-5 rounded-2xl border space-y-2 ${
                      status?.publicDemoModeEnabled
                        ? 'bg-amber-50/80 border-amber-300'
                        : 'bg-slate-50 border-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        title="Optional sandbox bucket used strictly to demonstrate how public-read bucket policies behave in isolation."
                        className="text-xs font-bold text-slate-900 underline decoration-dotted cursor-help"
                      >
                        Public-Read Demo Sandbox
                      </span>
                      {status?.publicDemoModeEnabled ? (
                        <AlertTriangle className="w-5 h-5 text-amber-600" />
                      ) : (
                        <ShieldCheck className="w-5 h-5 text-slate-600" />
                      )}
                    </div>
                    <div className="text-lg font-bold text-slate-900">
                      {status?.publicDemoModeEnabled
                        ? 'Enabled (Isolated Sandbox)'
                        : 'Disabled (Locked)'}
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Isolated to{' '}
                      <code className="font-mono">{status?.publicDemoBucket}</code>. Never
                      weakens your main private bucket.
                    </p>
                  </div>
                </div>

                {/* Live Security Verification Action */}
                <div className="p-5 rounded-2xl bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-sm font-bold text-slate-900">
                      Test Anonymous Access Block Live
                    </div>
                    <p className="text-xs text-slate-600">
                      Attempt to download a private file without credentials or a pre-signed
                      signature to verify the server returns HTTP 403 AccessDenied.
                    </p>
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0">
                    {allObjects.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          const target = allObjects[0];
                          const encodedKey = target.key
                            .split('/')
                            .map(encodeURIComponent)
                            .join('/');
                          handleTestUrlAccess(
                            `/s3/${encodeURIComponent(target.bucket)}/${encodedKey}`,
                            `Anonymous Direct Request (${target.filename})`
                          );
                        }}
                        className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold cursor-pointer"
                      >
                        Test Anonymous Access (Expect 403)
                      </button>
                    )}

                    {status?.publicDemoModeEnabled ? (
                      <button
                        type="button"
                        onClick={() => handleToggleSandboxMode(false)}
                        className="px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold cursor-pointer"
                      >
                        Disable Public Sandbox
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setSandboxModalOpen(true)}
                        className="px-4 py-2.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 text-xs font-semibold cursor-pointer"
                      >
                        Configure Sandbox Demo...
                      </button>
                    )}
                  </div>
                </div>

                {probeResult && (
                  <div
                    className={`p-4 rounded-2xl border space-y-2 ${
                      probeResult.allowed
                        ? 'bg-amber-50 border-amber-200'
                        : 'bg-teal-50 border-teal-200'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-900">
                        Security Probe: {probeResult.targetType}
                      </span>
                      <span className="font-mono font-bold text-teal-800">
                        {probeResult.statusText}
                      </span>
                    </div>
                    <pre className="p-3 rounded-xl bg-white border border-slate-200 text-xs font-mono text-slate-700 overflow-x-auto whitespace-pre-wrap">
                      {probeResult.responsePreview}
                    </pre>
                  </div>
                )}

                {/* How It Works — 3 Beginner-Friendly Cards */}
                <div className="pt-2 space-y-3">
                  <h2 className="text-base font-bold text-slate-900">
                    How it works
                  </h2>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="p-5 rounded-2xl border border-indigo-100 bg-indigo-50/40 space-y-2">
                      <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white font-bold text-xs flex items-center justify-center">
                        1
                      </div>
                      <h3 className="text-sm font-bold text-slate-900">
                        Private files require authorization
                      </h3>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        Every file in your main bucket is private. Guessing the file URL in a
                        browser will always be blocked with an Access Denied message.
                      </p>
                    </div>

                    <div className="p-5 rounded-2xl border border-indigo-100 bg-violet-50/40 space-y-2">
                      <div className="w-8 h-8 rounded-lg bg-violet-600 text-white font-bold text-xs flex items-center justify-center">
                        2
                      </div>
                      <h3 className="text-sm font-bold text-slate-900">
                        Pre-signed URLs provide temporary access
                      </h3>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        When you need to share a private file, the server signs a special link
                        with a built-in timer (60s, 5m, or 15m) without opening your bucket.
                      </p>
                    </div>

                    <div className="p-5 rounded-2xl border border-indigo-100 bg-teal-50/40 space-y-2">
                      <div className="w-8 h-8 rounded-lg bg-teal-600 text-white font-bold text-xs flex items-center justify-center">
                        3
                      </div>
                      <h3 className="text-sm font-bold text-slate-900">
                        Expired links no longer authorize downloads
                      </h3>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        As soon as the timer expires, the cryptographic signature becomes
                        invalid and any further download attempts are automatically rejected.
                      </p>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          )}

          {/* ===============================================================
              PAGE 5: AUTOMATED TESTING DASHBOARD
          =============================================================== */}
          {activeNav === 'tests' && (
            <div className="space-y-6">
              <section className="bg-white rounded-2xl border border-indigo-100 p-6 sm:p-8 shadow-2xs space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 px-3 py-1 rounded-lg border border-indigo-200">
                      <FlaskConical className="w-3.5 h-3.5" />
                      <span>Live Python Unittest / Pytest Verification</span>
                    </div>
                    <h1 className="text-2xl font-bold text-slate-900 font-display">
                      Automated Security & Storage Test Suite
                    </h1>
                    <p className="text-sm text-slate-600">
                      Executes the real Python test suite against a local S3-compatible server
                      to verify uploads, tags, anonymous blocks, and link expiration.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleRunTests}
                    disabled={runningTests}
                    className="px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs shadow-xs transition-colors inline-flex items-center gap-2 shrink-0 cursor-pointer"
                  >
                    <RefreshCw
                      className={`w-4 h-4 ${runningTests ? 'animate-spin' : ''}`}
                    />
                    <span>{runningTests ? 'Running Test Suite...' : 'Run Test Suite'}</span>
                  </button>
                </div>

                {runningTests && !testResult && (
                  <div className="py-12 text-center space-y-3">
                    <RefreshCw className="w-8 h-8 text-indigo-600 animate-spin mx-auto" />
                    <div className="text-sm font-semibold text-slate-800">
                      Executing automated Python storage and security tests...
                    </div>
                  </div>
                )}

                {testResult && (
                  <>
                    {/* 4 Summary Metric Cards */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                      <div className="p-4 rounded-2xl bg-indigo-50/70 border border-indigo-200">
                        <div className="text-xs font-semibold text-indigo-900">
                          Tests Executed
                        </div>
                        <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1">
                          {testResult.totalTests}
                        </div>
                      </div>

                      <div className="p-4 rounded-2xl bg-teal-50/70 border border-teal-200">
                        <div className="text-xs font-semibold text-teal-900">
                          Passed Tests
                        </div>
                        <div className="text-2xl font-bold font-mono tabular-nums text-teal-700 mt-1">
                          {testResult.passedCount}
                        </div>
                      </div>

                      <div
                        className={`p-4 rounded-2xl border ${
                          testResult.failedCount > 0
                            ? 'bg-rose-50 border-rose-200'
                            : 'bg-slate-50 border-slate-200'
                        }`}
                      >
                        <div className="text-xs font-semibold text-slate-700">
                          Failed Tests
                        </div>
                        <div
                          className={`text-2xl font-bold font-mono tabular-nums mt-1 ${
                            testResult.failedCount > 0
                              ? 'text-rose-700'
                              : 'text-slate-900'
                          }`}
                        >
                          {testResult.failedCount}
                        </div>
                      </div>

                      <div className="p-4 rounded-2xl bg-sky-50/70 border border-sky-200">
                        <div className="text-xs font-semibold text-sky-900">
                          Execution Duration
                        </div>
                        <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1">
                          {(testResult.durationMs / 1000).toFixed(2)}s
                        </div>
                      </div>
                    </div>

                    {/* Individual Test Results List */}
                    <div className="space-y-2.5">
                      {testResult.tests.map((test) => (
                        <div
                          key={`${test.suite}.${test.name}`}
                          className={`p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                            test.status === 'PASS'
                              ? 'bg-teal-50/40 border-teal-200'
                              : 'bg-rose-50 border-rose-200'
                          }`}
                        >
                          <div className="space-y-0.5">
                            <div className="font-mono text-xs font-bold text-slate-900">
                              {test.name}
                            </div>
                            <p className="text-xs text-slate-600">{test.description}</p>
                          </div>
                          <span
                            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold font-mono shrink-0 ${
                              test.status === 'PASS'
                                ? 'bg-teal-600 text-white'
                                : 'bg-rose-600 text-white'
                            }`}
                          >
                            {test.status === 'PASS' ? (
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            ) : (
                              <XCircle className="w-3.5 h-3.5" />
                            )}
                            <span>{test.status}</span>
                          </span>
                        </div>
                      ))}
                    </div>

                    {/* Raw Runner Output */}
                    <div className="space-y-2 pt-2">
                      <div className="text-xs font-bold text-slate-700">
                        Console Execution Log
                      </div>
                      <pre className="p-4 rounded-2xl bg-slate-900 text-slate-100 text-xs font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed">
                        {testResult.rawOutput}
                      </pre>
                    </div>
                  </>
                )}
              </section>
            </div>
          )}

          {/* ===============================================================
              PAGE 6: SETTINGS & PROJECT FILES INSPECTOR
          =============================================================== */}
          {activeNav === 'settings' && (
            <div className="space-y-6">
              <section className="bg-white rounded-2xl border border-indigo-100 p-6 sm:p-8 shadow-2xs space-y-6">
                <div>
                  <h1 className="text-2xl font-bold text-slate-900 font-display">
                    Storage & Application Settings
                  </h1>
                  <p className="text-sm text-slate-600 mt-0.5">
                    Configure default link expiration and inspect your local S3/MinIO project
                    files. Sensitive credentials are never shown in the UI.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="p-5 rounded-2xl bg-slate-50 border border-slate-200 space-y-3">
                    <h2 className="text-sm font-bold text-slate-900">
                      Default Temporary Link Expiration
                    </h2>
                    <p className="text-xs text-slate-600">
                      Choose the default expiration duration used when creating pre-signed
                      sharing links.
                    </p>
                    <div className="flex items-center gap-3">
                      <select
                        value={defaultExpirySetting}
                        onChange={(e) =>
                          setDefaultExpirySetting(Number(e.target.value))
                        }
                        className="px-3.5 py-2 text-xs border border-slate-300 rounded-xl bg-white font-medium"
                      >
                        <option value={60}>60 seconds</option>
                        <option value={300}>5 minutes (300s)</option>
                        <option value={900}>15 minutes (900s)</option>
                      </select>
                      <button
                        type="button"
                        onClick={async () => {
                          const res = await fetch('/api/storage/settings', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              defaultPresignedExpiration: defaultExpirySetting,
                            }),
                          });
                          const data = await res.json();
                          if (res.ok) {
                            setShareExpirationSeconds(defaultExpirySetting);
                            pushToast('success', 'Settings Saved', data.message);
                            await refreshAll();
                          }
                        }}
                        className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold"
                      >
                        Save Preference
                      </button>
                    </div>
                  </div>

                  <div className="p-5 rounded-2xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
                    <h2 className="text-sm font-bold text-slate-900">
                      Environment Configuration Summary
                    </h2>
                    <div className="flex justify-between py-1 border-b border-slate-200/60">
                      <span className="text-slate-500">S3 Endpoint</span>
                      <span className="font-mono font-semibold text-slate-800">
                        {status?.endpointUrl}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-200/60">
                      <span className="text-slate-500">Primary Private Bucket</span>
                      <span className="font-mono font-semibold text-indigo-700">
                        {status?.privateBucket}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-200/60">
                      <span className="text-slate-500">Isolated Demo Sandbox</span>
                      <span className="font-mono text-slate-800">
                        {status?.publicDemoBucket}
                      </span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-slate-500">Region</span>
                      <span className="font-mono text-slate-800">{status?.region}</span>
                    </div>
                  </div>
                </div>
              </section>

              {/* Python Project Files Browser */}
              <section className="bg-white rounded-2xl border border-indigo-100 p-6 shadow-2xs space-y-4">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Python & MinIO Project Files (cloud-storage-organizer/)
                  </h2>
                  <p className="text-xs text-slate-500">
                    Inspect or copy any file from the complete Python 3.12, Boto3, Docker
                    Compose, and Pytest codebase.
                  </p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  <div className="lg:col-span-4 space-y-1">
                    {projectFiles.map((file, idx) => (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => setSelectedSourceIdx(idx)}
                        className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-mono flex items-center justify-between transition-colors ${
                          selectedSourceIdx === idx
                            ? 'bg-indigo-600 text-white font-semibold'
                            : 'text-slate-700 hover:bg-indigo-50'
                        }`}
                      >
                        <span className="truncate">{file.name}</span>
                        <span
                          className={`text-[11px] tabular-nums ${
                            selectedSourceIdx === idx
                              ? 'text-indigo-200'
                              : 'text-slate-400'
                          }`}
                        >
                          {formatBytes(file.sizeBytes)}
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className="lg:col-span-8 space-y-3">
                    {projectFiles[selectedSourceIdx] && (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-mono font-bold text-slate-800">
                            {projectFiles[selectedSourceIdx].path}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(
                                projectFiles[selectedSourceIdx].content
                              );
                              setCopiedSource(true);
                              setTimeout(() => setCopiedSource(false), 2000);
                            }}
                            className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold inline-flex items-center gap-1.5"
                          >
                            {copiedSource ? (
                              <Check className="w-3.5 h-3.5 text-teal-600" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                            <span>{copiedSource ? 'Copied!' : 'Copy Code'}</span>
                          </button>
                        </div>
                        <pre className="p-4 rounded-2xl bg-slate-900 text-slate-100 text-xs font-mono overflow-x-auto max-h-[540px] leading-relaxed">
                          {projectFiles[selectedSourceIdx].content}
                        </pre>
                      </>
                    )}
                  </div>
                </div>
              </section>
            </div>
          )}
        </main>
      </div>

      {/* =====================================================================
          MODAL 1: UPLOAD FILES MODAL
      ===================================================================== */}
      {uploadModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl border border-indigo-100 max-w-xl w-full p-6 shadow-xl space-y-5 my-8">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900 font-display">
                  Upload Files to Cloud Storage
                </h2>
                <p className="text-xs text-slate-500">
                  Organize files by category, attach metadata and tags, and keep them private
                  by default.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setUploadModalOpen(false)}
                className="p-1.5 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Drag and Drop Zone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingOver(true);
              }}
              onDragLeave={() => setIsDraggingOver(false)}
              onDrop={(e) => handleDropFiles(e, false)}
              onClick={() => fileInputRef.current?.click()}
              className={`p-6 rounded-2xl border-2 border-dashed text-center transition-all cursor-pointer space-y-2 ${
                isDraggingOver
                  ? 'border-indigo-600 bg-indigo-50'
                  : 'border-indigo-200 bg-indigo-50/40 hover:border-indigo-400'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={(e) => {
                  const chosen = Array.from(e.target.files || []);
                  if (chosen.length > 0) {
                    setUploadQueue((prev) => [...prev, ...chosen]);
                  }
                }}
                className="hidden"
              />
              <div className="w-12 h-12 rounded-2xl bg-indigo-600 text-white flex items-center justify-center mx-auto shadow-xs">
                <Upload className="w-6 h-6" />
              </div>
              <div className="text-sm font-bold text-slate-900">
                Drag and drop files here, or browse your computer.
              </div>
              <p className="text-xs text-slate-500">
                Click to select one or multiple files (PDF, PNG, SVG, CSV, TXT, JSON)
              </p>
            </div>

            {/* Quick Sample Files for Beginner Testing */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-slate-400 mr-1">Or add a sample file:</span>
              <button
                type="button"
                onClick={() =>
                  addStarterFileToQueue(
                    'security_checklist_2026.pdf',
                    'documents',
                    'application/pdf',
                    '%PDF-1.7\nCloud Storage Security Checklist\n'
                  )
                }
                className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 font-medium"
              >
                + Sample PDF
              </button>
              <button
                type="button"
                onClick={() =>
                  addStarterFileToQueue(
                    'monthly_storage_metrics.csv',
                    'reports',
                    'text/csv',
                    'category,files,status\ndocuments,12,private\nreports,8,private\n'
                  )
                }
                className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 font-medium"
              >
                + Sample CSV
              </button>
              <button
                type="button"
                onClick={() =>
                  addStarterFileToQueue(
                    'project_milestones.txt',
                    'projects',
                    'text/plain',
                    'Milestone 1: S3 Bucket Protection Enabled\nMilestone 2: Pre-Signed Links Verified\n'
                  )
                }
                className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 font-medium"
              >
                + Sample TXT
              </button>
            </div>

            {/* Selected Files Queue */}
            {uploadQueue.length > 0 && (
              <div className="space-y-1.5 max-h-32 overflow-y-auto p-3 rounded-xl bg-slate-50 border border-slate-200">
                {uploadQueue.map((f, i) => (
                  <div
                    key={`${f.name}-${i}`}
                    className="flex items-center justify-between text-xs py-1"
                  >
                    <span className="font-semibold text-slate-800 truncate">
                      {f.name}{' '}
                      <span className="text-slate-400 font-mono">
                        ({formatBytes(f.size)})
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setUploadQueue((prev) => prev.filter((_, idx) => idx !== i))
                      }
                      className="text-slate-400 hover:text-rose-600"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Category & Metadata Inputs */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Category Folder
                </label>
                <select
                  value={uploadCategoryChoice}
                  onChange={(e) => setUploadCategoryChoice(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-xl bg-white font-medium"
                >
                  <option value="documents">Documents (documents/)</option>
                  <option value="images">Images (images/)</option>
                  <option value="reports">Reports (reports/)</option>
                  <option value="projects">Projects (projects/)</option>
                  <option value="custom">Custom Folder Prefix...</option>
                </select>
              </div>

              {uploadCategoryChoice === 'custom' ? (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Custom Folder Name
                  </label>
                  <input
                    type="text"
                    value={customCategoryName}
                    onChange={(e) => setCustomCategoryName(e.target.value)}
                    placeholder="e.g. archives"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-xl font-mono"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Department (Optional)
                  </label>
                  <input
                    type="text"
                    value={uploadDepartment}
                    onChange={(e) => setUploadDepartment(e.target.value)}
                    placeholder="e.g. IT, Marketing, Security"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-xl"
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Owner (Optional)
                </label>
                <input
                  type="text"
                  value={uploadOwner}
                  onChange={(e) => setUploadOwner(e.target.value)}
                  placeholder="Your name or team"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-xl"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Description (Optional)
                </label>
                <input
                  type="text"
                  value={uploadDescription}
                  onChange={(e) => setUploadDescription(e.target.value)}
                  placeholder="Short note about this file"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-xl"
                />
              </div>
            </div>

            {/* Object Tags Editor in Upload Modal */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-700">
                Object Tags
              </label>
              <div className="flex flex-wrap gap-1.5">
                {uploadTags.map((t, i) => (
                  <span
                    key={`${t.key}-${i}`}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border ${getTagPillStyle(
                      i
                    )}`}
                  >
                    <span>
                      {t.key === 'Category' || t.key === 'Type'
                        ? t.value
                        : `${t.key}: ${t.value}`}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setUploadTags((prev) => prev.filter((_, idx) => idx !== i))
                      }
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={uploadTagDraft}
                  onChange={(e) => setUploadTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const raw = uploadTagDraft.trim();
                      if (!raw) return;
                      const [k, v] = raw.includes(':')
                        ? raw.split(':')
                        : ['Tag', raw];
                      setUploadTags((prev) => [
                        ...prev,
                        { key: k.trim(), value: (v || raw).trim() },
                      ]);
                      setUploadTagDraft('');
                    }
                  }}
                  placeholder="Type a tag (e.g. Project or Department: IT) and press Add"
                  className="flex-1 px-3 py-1.5 text-xs border border-slate-300 rounded-xl"
                />
                <button
                  type="button"
                  onClick={() => {
                    const raw = uploadTagDraft.trim();
                    if (!raw) return;
                    const [k, v] = raw.includes(':')
                      ? raw.split(':')
                      : ['Tag', raw];
                    setUploadTags((prev) => [
                      ...prev,
                      { key: k.trim(), value: (v || raw).trim() },
                    ]);
                    setUploadTagDraft('');
                  }}
                  className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold"
                >
                  Add Tag
                </button>
              </div>
            </div>

            {/* Private Access Indicator (Enabled by Default) */}
            <div className="p-3.5 rounded-xl bg-teal-50/80 border border-teal-200 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Lock className="w-4 h-4 text-teal-700 shrink-0" />
                <div className="text-xs">
                  <div className="font-bold text-teal-950">
                    Private Access Enabled by Default
                  </div>
                  <div className="text-teal-800">
                    Uploaded files are stored in your private vault and blocked from public
                    access.
                  </div>
                </div>
              </div>
            </div>

            {/* Progress Bar */}
            {isUploading && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs font-mono text-indigo-700">
                  <span>Uploading to S3 bucket...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-indigo-100 overflow-hidden">
                  <div
                    className="h-full bg-indigo-600 transition-all duration-200"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Modal Actions */}
            <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setUploadQueue([]);
                  setUploadModalOpen(false);
                }}
                className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isUploading}
                onClick={() => executeUploadFiles(uploadQueue)}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs cursor-pointer"
              >
                {isUploading
                  ? 'Uploading...'
                  : `Upload ${uploadQueue.length > 0 ? `(${uploadQueue.length})` : 'Files'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL 2: DELETE CONFIRMATION DIALOG
      ===================================================================== */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-rose-200 max-w-md w-full p-6 shadow-xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Delete File Permanently?
                </h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Are you sure you want to delete{' '}
                  <span className="font-semibold text-slate-900">
                    {deleteTarget.filename}
                  </span>{' '}
                  from <code className="font-mono">{deleteTarget.category}/</code>? This
                  action cannot be undone.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeleting}
                onClick={handleConfirmDelete}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold cursor-pointer"
              >
                {isDeleting ? 'Deleting...' : 'Yes, Delete File'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL 3: ISOLATED PUBLIC SANDBOX CONFIRMATION DIALOG
      ===================================================================== */}
      {sandboxModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-amber-200 max-w-md w-full p-6 shadow-xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Enable Isolated Public-Read Demo Mode?
                </h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  This enables anonymous read access strictly on the separate disposable
                  sandbox bucket (
                  <code className="font-mono">{status?.publicDemoBucket}</code>). Your main
                  private bucket (<code className="font-mono">{status?.privateBucket}</code>)
                  will remain 100% private.
                </p>
              </div>
            </div>

            <label className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-950 cursor-pointer">
              <input
                type="checkbox"
                checked={sandboxConfirmChecked}
                onChange={(e) => setSandboxConfirmChecked(e.target.checked)}
                className="mt-0.5 rounded"
              />
              <span>
                I understand and confirm enabling public-read demonstration mode on the
                isolated sandbox bucket.
              </span>
            </label>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => {
                  setSandboxModalOpen(false);
                  setSandboxConfirmChecked(false);
                }}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!sandboxConfirmChecked}
                onClick={() => handleToggleSandboxMode(true)}
                className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer"
              >
                Confirm & Enable Sandbox
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
