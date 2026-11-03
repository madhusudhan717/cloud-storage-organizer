"""
Configuration and security validation module for Cloud Storage Organizer.

Loads environment variables via python-dotenv, validates storage settings,
enforces safe filename sanitization, and ensures credentials are never exposed.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlparse

try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv(dotenv_path: Optional[os.PathLike | str] = None, **_kwargs: object) -> bool:
        """Fallback .env loader when python-dotenv is not installed in minimal environments."""
        target = Path(dotenv_path) if dotenv_path else Path(".env")
        if not target.is_file():
            return False
        for raw_line in target.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            os.environ.setdefault(key, val)
        return True

# Load environment variables from .env if present
load_dotenv()

ALLOWED_CATEGORIES: Dict[str, str] = {
    "documents": "documents/",
    "images": "images/",
    "reports": "reports/",
    "projects": "projects/",
}

ALLOWED_EXTENSIONS: set[str] = {
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".xml",
    ".log",
    ".zip",
    ".docx",
    ".xlsx",
}

PRESIGNED_EXPIRY_OPTIONS: Dict[str, int] = {
    "60 seconds": 60,
    "5 minutes": 300,
    "15 minutes": 900,
}

BASE_DIR = Path(__file__).resolve().parent
SAFE_STORAGE_DIR = BASE_DIR / "storage"


class StorageConfigError(ValueError):
    """Raised when storage configuration is missing, malformed, or insecure."""


def mask_secret(value: Optional[str]) -> str:
    """
    Mask a sensitive string so that secret keys are never exposed in UI, logs,
    or exception messages.
    """
    if not value:
        return "<NOT_SET>"
    if len(value) <= 4:
        return "****"
    return f"{value[:2]}{'*' * (len(value) - 4)}{value[-2:]}"


def sanitize_filename(filename: str) -> str:
    """
    Validate and sanitize a user-provided file name.
    Prevents path traversal (../, /, \\), null bytes, and hidden system files.
    """
    if not filename or not filename.strip():
        raise StorageConfigError("File name cannot be empty.")

    if "\x00" in filename:
        raise StorageConfigError("Invalid null byte detected in file name.")

    # Reject explicit directory traversal sequences before extracting basename
    normalized = filename.replace("\\", "/")
    if ".." in normalized.split("/") or normalized.startswith("/"):
        raise StorageConfigError(
            "Path traversal sequences are prohibited in file names."
        )

    clean_name = os.path.basename(normalized).strip()
    if not clean_name or clean_name in {".", ".."} or clean_name.startswith("."):
        raise StorageConfigError("Invalid or hidden file name is not permitted.")

    # Replace any unsafe characters with underscores while preserving extension
    clean_name = re.sub(r"[^A-Za-z0-9._-]", "_", clean_name)
    return clean_name


def validate_category(category: str) -> str:
    """
    Validate that the chosen category maps to an approved S3 object-key prefix.
    Returns the normalized prefix (e.g., 'documents/').
    """
    normalized = category.strip().lower().rstrip("/")
    if normalized not in ALLOWED_CATEGORIES:
        valid_keys = ", ".join(sorted(ALLOWED_CATEGORIES.keys()))
        raise StorageConfigError(
            f"Unsupported category '{category}'. Allowed categories: {valid_keys}"
        )
    return ALLOWED_CATEGORIES[normalized]


@dataclass(frozen=True)
class StorageConfig:
    """
    Immutable configuration container for S3 / MinIO object storage.
    Never exposes S3_SECRET_KEY in string representations.
    """

    endpoint_url: str
    access_key: str
    secret_key: str = field(repr=False)
    bucket_name: str = "cloud-organizer-private"
    public_demo_bucket: str = "cloud-organizer-public-sandbox"
    region: str = "us-east-1"
    default_presigned_expiration: int = 300

    def validate(self) -> None:
        """Validate all configuration parameters prior to initializing S3 client."""
        if not self.endpoint_url:
            raise StorageConfigError("S3_ENDPOINT_URL is required.")

        parsed = urlparse(self.endpoint_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise StorageConfigError(
                f"Invalid S3_ENDPOINT_URL '{self.endpoint_url}'. Expected http(s)://host:port."
            )

        if not self.access_key or not self.access_key.strip():
            raise StorageConfigError("S3_ACCESS_KEY must not be empty.")

        if not self.secret_key or not self.secret_key.strip():
            raise StorageConfigError("S3_SECRET_KEY must not be empty.")

        if not self.bucket_name or not re.match(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", self.bucket_name):
            raise StorageConfigError(
                f"Invalid S3_BUCKET_NAME '{self.bucket_name}'. Must follow S3 bucket naming rules."
            )

        if self.bucket_name == self.public_demo_bucket:
            raise StorageConfigError(
                "S3_PUBLIC_DEMO_BUCKET must be distinct from the main private S3_BUCKET_NAME."
            )

        if self.default_presigned_expiration < 1 or self.default_presigned_expiration > 604800:
            raise StorageConfigError(
                "DEFAULT_PRESIGNED_EXPIRATION must be between 1 and 604800 seconds (7 days)."
            )

    def to_safe_dict(self) -> Dict[str, str | int]:
        """Return a dictionary safe for logging or UI display with secret key masked."""
        return {
            "endpoint_url": self.endpoint_url,
            "access_key": mask_secret(self.access_key),
            "secret_key": mask_secret(self.secret_key),
            "bucket_name": self.bucket_name,
            "public_demo_bucket": self.public_demo_bucket,
            "region": self.region,
            "default_presigned_expiration": self.default_presigned_expiration,
        }

    @classmethod
    def from_env(cls, env_override: Optional[Dict[str, str]] = None) -> "StorageConfig":
        """Load configuration from environment variables with optional overrides."""
        source = os.environ if env_override is None else {**os.environ, **env_override}

        raw_expiry = source.get("DEFAULT_PRESIGNED_EXPIRATION", "300")
        try:
            expiry = int(raw_expiry)
        except ValueError as exc:
            raise StorageConfigError(
                f"DEFAULT_PRESIGNED_EXPIRATION must be an integer, got '{raw_expiry}'."
            ) from exc

        cfg = cls(
            endpoint_url=source.get("S3_ENDPOINT_URL", "http://localhost:9000").strip(),
            access_key=source.get("S3_ACCESS_KEY", "minioadmin").strip(),
            secret_key=source.get("S3_SECRET_KEY", "minioadmin123").strip(),
            bucket_name=source.get("S3_BUCKET_NAME", "cloud-organizer-private").strip(),
            public_demo_bucket=source.get(
                "S3_PUBLIC_DEMO_BUCKET", "cloud-organizer-public-sandbox"
            ).strip(),
            region=source.get("S3_REGION", "us-east-1").strip(),
            default_presigned_expiration=expiry,
        )
        cfg.validate()
        return cfg
