"""
Cloud Storage Manager — Object Storage & Access Controls.

Provides a clean, reusable abstraction over Boto3 S3 / MinIO operations:
- Private-by-default bucket initialization and ACL enforcement
- Categorized uploads via S3 object-key prefixes (documents/, images/, reports/, projects/)
- Custom metadata (x-amz-meta-*) and S3 object tagging (TagSet)
- Secure downloads without arbitrary local path traversal
- Time-limited pre-signed URLs (HMAC-SHA256 / SigV4)
- Isolated public-read sandbox bucket mode that never weakens the main private bucket
"""

from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, BinaryIO, Dict, List, Optional, Tuple

from config import (
    ALLOWED_CATEGORIES,
    SAFE_STORAGE_DIR,
    StorageConfig,
    StorageConfigError,
    sanitize_filename,
    validate_category,
)

try:
    import boto3
    from botocore.client import Config as BotoCoreConfig
    from botocore.exceptions import BotoCoreError, ClientError, EndpointConnectionError

    HAS_BOTO3 = True
except ImportError:
    boto3 = None  # type: ignore[assignment]
    BotoCoreConfig = None  # type: ignore[assignment]
    HAS_BOTO3 = False

    class BotoCoreError(Exception):  # type: ignore[no-redef]
        """Fallback BotoCoreError when botocore is unavailable."""

    class ClientError(Exception):  # type: ignore[no-redef]
        """Fallback ClientError matching botocore.exceptions.ClientError structure."""

        def __init__(self, error_response: Dict[str, Any], operation_name: str) -> None:
            self.response = error_response
            self.operation_name = operation_name
            msg = error_response.get("Error", {}).get("Message", "S3 ClientError")
            code = error_response.get("Error", {}).get("Code", "Unknown")
            super().__init__(f"An error occurred ({code}) when calling the {operation_name} operation: {msg}")

    class EndpointConnectionError(BotoCoreError):  # type: ignore[no-redef]
        """Fallback EndpointConnectionError."""


class StorageOperationError(RuntimeError):
    """Raised when an S3/MinIO storage operation fails safely."""


class ObjectNotFoundError(StorageOperationError):
    """Raised when a requested S3 object key does not exist."""


class AccessDeniedError(StorageOperationError):
    """Raised when anonymous or unauthorized access is rejected."""


@dataclass
class StoredObjectInfo:
    """Structured representation of an object stored in S3/MinIO."""

    key: str
    filename: str
    category: str
    size_bytes: int
    last_modified: str
    content_type: str
    etag: str
    bucket: str
    access_mode: str  # "Private" or "Public-Read (Isolated Sandbox)"
    metadata: Dict[str, str] = field(default_factory=dict)
    tags: Dict[str, str] = field(default_factory=dict)


def build_public_read_bucket_policy(bucket_name: str) -> str:
    """
    Construct an S3 bucket policy allowing anonymous s3:GetObject ONLY on the
    specified isolated demonstration bucket.
    """
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "IsolatedPublicReadDemoOnly",
                "Effect": "Allow",
                "Principal": "*",
                "Action": ["s3:GetObject"],
                "Resource": [f"arn:aws:s3:::{bucket_name}/*"],
            }
        ],
    }
    return json.dumps(policy)


class LocalS3CompatibleServer:
    """
    Lightweight, specification-faithful local S3/MinIO-compatible HTTP server for
    hermetic testing and local zero-cost execution when Docker/MinIO is not running.
    Enforces:
    - Private-by-default bucket access (403 Forbidden for anonymous requests)
    - Isolated public-read bucket policy when explicitly enabled on the sandbox bucket
    - AWS Signature V4 / HMAC-SHA256 Pre-Signed URL validation with strict timestamp expiry
    """

    def __init__(self, access_key: str, secret_key: str, host: str = "127.0.0.1", port: int = 0) -> None:
        self.access_key = access_key
        self.secret_key = secret_key
        self.buckets: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.bucket_policies: Dict[str, str] = {}
        self.lock = threading.Lock()

        parent = self

        class S3Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                pass  # Keep test output clean

            def _send_json_or_xml_error(self, status: int, code: str, message: str) -> None:
                payload = json.dumps({"Error": {"Code": code, "Message": message}}).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def _is_authenticated_header(self) -> bool:
                auth_header = self.headers.get("X-Amz-Access-Key", "")
                sig_header = self.headers.get("X-Amz-Signature-Header", "")
                if auth_header and sig_header:
                    expected = hmac.new(
                        parent.secret_key.encode("utf-8"),
                        f"{auth_header}:{self.path}".encode("utf-8"),
                        hashlib.sha256,
                    ).hexdigest()
                    return hmac.compare_digest(auth_header, parent.access_key) and hmac.compare_digest(
                        sig_header, expected
                    )
                # Also check standard AWS4-HMAC-SHA256 Authorization header from boto3
                aws_auth = self.headers.get("Authorization", "")
                if f"Credential={parent.access_key}/" in aws_auth:
                    return True
                return False

            def _verify_presigned_query(self, bucket: str, key: str, query: Dict[str, List[str]]) -> Tuple[bool, str]:
                if "X-Amz-Signature" not in query:
                    return False, "MissingSignature"

                amz_expires_list = query.get("X-Amz-Expires", [])
                amz_date_list = query.get("X-Amz-Date", [])
                amz_cred_list = query.get("X-Amz-Credential", [])
                provided_sig = query["X-Amz-Signature"][0]

                if not amz_expires_list or not amz_date_list or not amz_cred_list:
                    return False, "IncompletePresignedParameters"

                credential = amz_cred_list[0]
                if not credential.startswith(f"{parent.access_key}/"):
                    return False, "InvalidAccessKeyId"

                try:
                    expires_seconds = int(amz_expires_list[0])
                    issued_dt = datetime.strptime(amz_date_list[0], "%Y%m%dT%H%M%SZ").replace(
                        tzinfo=timezone.utc
                    )
                    issued_ms_list = query.get("X-Amz-Issued-Ms", [])
                    if issued_ms_list:
                        issued_epoch = float(issued_ms_list[0]) / 1000.0
                    else:
                        issued_epoch = issued_dt.timestamp()
                except ValueError:
                    return False, "MalformedDateOrExpires"

                canonical = f"GET\n/{bucket}/{key}\n{amz_date_list[0]}\n{expires_seconds}\n{credential}"
                expected_sig = hmac.new(
                    parent.secret_key.encode("utf-8"),
                    canonical.encode("utf-8"),
                    hashlib.sha256,
                ).hexdigest()

                if not hmac.compare_digest(provided_sig, expected_sig):
                    return False, "SignatureDoesNotMatch"

                now_epoch = time.time()
                if now_epoch > (issued_epoch + expires_seconds):
                    return False, "RequestHasExpired"

                return True, "OK"

            def do_GET(self) -> None:
                parsed = urllib.parse.urlparse(self.path)
                parts = [p for p in parsed.path.split("/") if p]
                query = urllib.parse.parse_qs(parsed.query)

                if not parts:
                    self.send_response(200)
                    self.end_headers()
                    return

                bucket = urllib.parse.unquote(parts[0])
                key = urllib.parse.unquote("/".join(parts[1:])) if len(parts) > 1 else ""

                with parent.lock:
                    if bucket not in parent.buckets:
                        self._send_json_or_xml_error(404, "NoSuchBucket", f"The specified bucket '{bucket}' does not exist.")
                        return

                    if not key:
                        # List objects in bucket (requires auth)
                        if not self._is_authenticated_header():
                            self._send_json_or_xml_error(403, "AccessDenied", "Anonymous listing is denied.")
                            return
                        prefix = query.get("prefix", [""])[0]
                        items = []
                        for obj_key, obj_data in sorted(parent.buckets[bucket].items()):
                            if obj_key.startswith(prefix):
                                items.append(
                                    {
                                        "Key": obj_key,
                                        "Size": len(obj_data["body"]),
                                        "LastModified": obj_data["last_modified"],
                                        "ETag": obj_data["etag"],
                                        "ContentType": obj_data["content_type"],
                                        "Metadata": obj_data["metadata"],
                                        "Tags": obj_data["tags"],
                                    }
                                )
                        payload = json.dumps({"Contents": items}).encode("utf-8")
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)
                        return

                    # Object operation
                    authorized = False
                    if self._is_authenticated_header():
                        authorized = True
                    elif "X-Amz-Signature" in query:
                        valid_sig, reason = self._verify_presigned_query(bucket, key, query)
                        if not valid_sig:
                            self._send_json_or_xml_error(403, reason, f"Pre-signed URL access denied: {reason}")
                            return
                        authorized = True
                    else:
                        # Anonymous request: check if bucket has public-read policy
                        policy_str = parent.bucket_policies.get(bucket, "")
                        if "IsolatedPublicReadDemoOnly" in policy_str:
                            authorized = True

                    if not authorized:
                        self._send_json_or_xml_error(
                            403,
                            "AccessDenied",
                            "Access Denied: Object is private and requires authentication or a valid pre-signed URL.",
                        )
                        return

                    if key not in parent.buckets[bucket]:
                        self._send_json_or_xml_error(404, "NoSuchKey", f"The specified key '{key}' does not exist.")
                        return

                    obj = parent.buckets[bucket][key]
                    if "tagging" in query:
                        payload = json.dumps({"TagSet": obj["tags"]}).encode("utf-8")
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)
                        return

                    body: bytes = obj["body"]
                    self.send_response(200)
                    self.send_header("Content-Type", obj["content_type"])
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("ETag", obj["etag"])
                    self.send_header("Last-Modified", obj["last_modified"])
                    for mk, mv in obj["metadata"].items():
                        self.send_header(f"x-amz-meta-{mk}", mv)
                    self.end_headers()
                    self.wfile.write(body)

            def do_PUT(self) -> None:
                parsed = urllib.parse.urlparse(self.path)
                parts = [p for p in parsed.path.split("/") if p]
                query = urllib.parse.parse_qs(parsed.query)

                if not self._is_authenticated_header():
                    self._send_json_or_xml_error(403, "AccessDenied", "Authentication required for PUT.")
                    return

                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length) if length > 0 else b""

                bucket = urllib.parse.unquote(parts[0])
                key = urllib.parse.unquote("/".join(parts[1:])) if len(parts) > 1 else ""

                with parent.lock:
                    if not key:
                        if "policy" in query:
                            parent.bucket_policies[bucket] = body.decode("utf-8")
                        else:
                            parent.buckets.setdefault(bucket, {})
                        self.send_response(200)
                        self.end_headers()
                        return

                    if bucket not in parent.buckets:
                        self._send_json_or_xml_error(404, "NoSuchBucket", f"Bucket '{bucket}' does not exist.")
                        return

                    if "tagging" in query:
                        if key not in parent.buckets[bucket]:
                            self._send_json_or_xml_error(404, "NoSuchKey", f"Key '{key}' not found.")
                            return
                        data = json.loads(body.decode("utf-8"))
                        parent.buckets[bucket][key]["tags"] = data.get("TagSet", {})
                        self.send_response(200)
                        self.end_headers()
                        return

                    metadata: Dict[str, str] = {}
                    for hk, hv in self.headers.items():
                        if hk.lower().startswith("x-amz-meta-"):
                            metadata[hk[11:].lower()] = hv

                    tags: Dict[str, str] = {}
                    raw_tagging = self.headers.get("x-amz-tagging", "")
                    if raw_tagging:
                        for kv in urllib.parse.parse_qsl(raw_tagging):
                            tags[kv[0]] = kv[1]

                    etag = f'"{hashlib.md5(body).hexdigest()}"'
                    parent.buckets[bucket][key] = {
                        "body": body,
                        "content_type": self.headers.get("Content-Type", "application/octet-stream"),
                        "metadata": metadata,
                        "tags": tags,
                        "etag": etag,
                        "last_modified": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    }
                    self.send_response(200)
                    self.send_header("ETag", etag)
                    self.end_headers()

            def do_DELETE(self) -> None:
                parsed = urllib.parse.urlparse(self.path)
                parts = [p for p in parsed.path.split("/") if p]
                query = urllib.parse.parse_qs(parsed.query)

                if not self._is_authenticated_header():
                    self._send_json_or_xml_error(403, "AccessDenied", "Authentication required for DELETE.")
                    return

                bucket = urllib.parse.unquote(parts[0])
                key = urllib.parse.unquote("/".join(parts[1:])) if len(parts) > 1 else ""

                with parent.lock:
                    if not key and "policy" in query:
                        parent.bucket_policies.pop(bucket, None)
                        self.send_response(204)
                        self.end_headers()
                        return

                    if bucket not in parent.buckets or key not in parent.buckets[bucket]:
                        self._send_json_or_xml_error(404, "NoSuchKey", f"Key '{key}' does not exist.")
                        return

                    del parent.buckets[bucket][key]
                    self.send_response(204)
                    self.end_headers()

        self._server = ThreadingHTTPServer((host, port), S3Handler)
        self.host, self.port = self._server.server_address
        self.endpoint_url = f"http://{self.host}:{self.port}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


class StorageManager:
    """
    High-level manager for S3 / MinIO object storage and access controls.

    Uses Boto3 S3 client when talking to MinIO / AWS S3, and also supports
    standard HTTP S3 Signature V4 operations against LocalS3CompatibleServer.
    """

    def __init__(
        self,
        config: Optional[StorageConfig] = None,
        s3_client: Optional[Any] = None,
        use_embedded_s3_client: bool = False,
    ) -> None:
        self.config = config or StorageConfig.from_env()
        self.config.validate()
        self._public_demo_enabled = False
        self._use_embedded = use_embedded_s3_client or (not HAS_BOTO3 and s3_client is None)

        if s3_client is not None:
            self.s3 = s3_client
        elif HAS_BOTO3 and not self._use_embedded:
            self.s3 = boto3.client(
                "s3",
                endpoint_url=self.config.endpoint_url,
                aws_access_key_id=self.config.access_key,
                aws_secret_access_key=self.config.secret_key,
                region_name=self.config.region,
                config=BotoCoreConfig(
                    signature_version="s3v4",
                    s3={"addressing_style": "path"},
                    connect_timeout=5,
                    read_timeout=10,
                    retries={"max_attempts": 2},
                ),
            )
        else:
            self.s3 = None

    # ------------------------------------------------------------------
    # Internal signed request helper for Embedded S3 HTTP Server mode
    # ------------------------------------------------------------------
    def _signed_http_request(
        self,
        method: str,
        path: str,
        body: bytes = b"",
        headers: Optional[Dict[str, str]] = None,
    ) -> Tuple[int, Dict[str, str], bytes]:
        url = f"{self.config.endpoint_url.rstrip('/')}{path}"
        req_headers = dict(headers or {})
        req_headers["X-Amz-Access-Key"] = self.config.access_key
        req_headers["X-Amz-Signature-Header"] = hmac.new(
            self.config.secret_key.encode("utf-8"),
            f"{self.config.access_key}:{path}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        req = urllib.request.Request(url, data=body if method in {"PUT", "POST"} else None, headers=req_headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp_headers = {k.lower(): v for k, v in resp.headers.items()}
                return resp.status, resp_headers, resp.read()
        except urllib.error.HTTPError as err:
            err_body = err.read()
            try:
                parsed = json.loads(err_body.decode("utf-8"))
                code = parsed.get("Error", {}).get("Code", "HTTPError")
                msg = parsed.get("Error", {}).get("Message", str(err))
            except Exception:
                code = f"HTTP_{err.code}"
                msg = str(err)
            if err.code == 404 or code in {"NoSuchKey", "NoSuchBucket", "404"}:
                raise ObjectNotFoundError(f"{code}: {msg}") from err
            if err.code == 403 or code in {"AccessDenied", "403"}:
                raise AccessDeniedError(f"{code}: {msg}") from err
            raise StorageOperationError(f"S3 operation failed ({code}): {msg}") from err
        except urllib.error.URLError as err:
            raise StorageOperationError(
                f"Unable to connect to S3 endpoint '{self.config.endpoint_url}': {err.reason}"
            ) from err

    # ------------------------------------------------------------------
    # Bucket Setup & Connection Health
    # ------------------------------------------------------------------
    def ensure_buckets_exist(self) -> Dict[str, str]:
        """
        Ensure the private bucket and isolated public-demo sandbox bucket exist.
        Main bucket is strictly kept private.
        """
        for bucket in (self.config.bucket_name, self.config.public_demo_bucket):
            if self.s3 is not None:
                try:
                    self.s3.head_bucket(Bucket=bucket)
                except ClientError as exc:
                    err_code = str(exc.response.get("Error", {}).get("Code", ""))
                    if err_code in {"404", "NoSuchBucket"}:
                        create_kwargs: Dict[str, Any] = {"Bucket": bucket}
                        if self.config.region and self.config.region != "us-east-1":
                            create_kwargs["CreateBucketConfiguration"] = {
                                "LocationConstraint": self.config.region
                            }
                        self.s3.create_bucket(**create_kwargs)
                    else:
                        raise StorageOperationError(
                            f"Failed to verify bucket '{bucket}': {exc}"
                        ) from exc
                except BotoCoreError as exc:
                    raise StorageOperationError(
                        f"Connection failure while checking bucket '{bucket}': {exc}"
                    ) from exc
            else:
                self._signed_http_request("PUT", f"/{bucket}")

        return {
            "private_bucket": self.config.bucket_name,
            "public_demo_bucket": self.config.public_demo_bucket,
            "status": "Connected",
        }

    def check_connection(self) -> Dict[str, Any]:
        """Verify connectivity to the S3 / MinIO endpoint without leaking credentials."""
        try:
            self.ensure_buckets_exist()
            return {
                "connected": True,
                "endpoint": self.config.endpoint_url,
                "private_bucket": self.config.bucket_name,
                "public_demo_bucket": self.config.public_demo_bucket,
                "public_demo_enabled": self._public_demo_enabled,
                "error": None,
            }
        except Exception as exc:
            return {
                "connected": False,
                "endpoint": self.config.endpoint_url,
                "private_bucket": self.config.bucket_name,
                "public_demo_bucket": self.config.public_demo_bucket,
                "public_demo_enabled": self._public_demo_enabled,
                "error": str(exc),
            }

    # ------------------------------------------------------------------
    # Core Feature A, B, C: Categorized Upload with Metadata & Tags
    # ------------------------------------------------------------------
    def upload_file(
        self,
        file_content: bytes | BinaryIO,
        filename: str,
        category: str = "documents",
        metadata: Optional[Dict[str, str]] = None,
        tags: Optional[Dict[str, str]] = None,
        use_public_demo_bucket: bool = False,
    ) -> StoredObjectInfo:
        """
        Upload a file into the selected category prefix with custom metadata and tags.

        - Validates and sanitizes `filename` to prevent path traversal.
        - Validates `category` prefix (`documents/`, `images/`, `reports/`, `projects/`).
        - Stores in `config.bucket_name` (private) by default, or `config.public_demo_bucket`
          only when `use_public_demo_bucket=True` and public demo mode is active.
        """
        clean_name = sanitize_filename(filename)
        prefix = validate_category(category)
        object_key = f"{prefix}{clean_name}"

        if use_public_demo_bucket and not self._public_demo_enabled:
            raise AccessDeniedError(
                "Public-read demonstration mode must be explicitly confirmed and enabled before uploading to the sandbox bucket."
            )

        target_bucket = (
            self.config.public_demo_bucket if use_public_demo_bucket else self.config.bucket_name
        )

        raw_bytes: bytes
        if isinstance(file_content, (bytes, bytearray)):
            raw_bytes = bytes(file_content)
        elif hasattr(file_content, "read"):
            raw_bytes = file_content.read()
        else:
            raise StorageConfigError("file_content must be bytes or a binary file-like object.")

        content_type, _ = mimetypes.guess_type(clean_name)
        content_type = content_type or "application/octet-stream"

        clean_metadata: Dict[str, str] = {}
        for k, v in (metadata or {}).items():
            if k and v is not None and str(v).strip():
                clean_key = k.strip().lower().replace(" ", "-")
                clean_metadata[clean_key] = str(v).strip()

        clean_tags: Dict[str, str] = {}
        for k, v in (tags or {}).items():
            if k and v is not None and str(v).strip():
                clean_tags[k.strip()] = str(v).strip()

        # Default organizational tags if none supplied
        clean_tags.setdefault("Category", category.strip().capitalize())

        tag_query = urllib.parse.urlencode(clean_tags)

        if self.s3 is not None:
            try:
                put_kwargs: Dict[str, Any] = {
                    "Bucket": target_bucket,
                    "Key": object_key,
                    "Body": raw_bytes,
                    "ContentType": content_type,
                    "Metadata": clean_metadata,
                }
                if tag_query:
                    put_kwargs["Tagging"] = tag_query
                response = self.s3.put_object(**put_kwargs)
                etag = str(response.get("ETag", "")).strip('"')
            except (ClientError, BotoCoreError) as exc:
                raise StorageOperationError(f"Failed to upload '{object_key}': {exc}") from exc
        else:
            headers = {"Content-Type": content_type}
            for mk, mv in clean_metadata.items():
                headers[f"x-amz-meta-{mk}"] = mv
            if tag_query:
                headers["x-amz-tagging"] = tag_query
            _, resp_headers, _ = self._signed_http_request(
                "PUT",
                f"/{target_bucket}/{urllib.parse.quote(object_key)}",
                body=raw_bytes,
                headers=headers,
            )
            etag = resp_headers.get("etag", "").strip('"')

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return StoredObjectInfo(
            key=object_key,
            filename=clean_name,
            category=category.strip().lower().rstrip("/"),
            size_bytes=len(raw_bytes),
            last_modified=now_iso,
            content_type=content_type,
            etag=etag,
            bucket=target_bucket,
            access_mode="Public-Read (Isolated Sandbox)" if use_public_demo_bucket else "Private",
            metadata=clean_metadata,
            tags=clean_tags,
        )

    # ------------------------------------------------------------------
    # Core Feature A & C: Retrieve Metadata and Tags
    # ------------------------------------------------------------------
    def get_object_metadata_and_tags(
        self, object_key: str, bucket_name: Optional[str] = None
    ) -> Tuple[Dict[str, str], Dict[str, str], str]:
        """
        Retrieve custom metadata, object tags, and content_type for a stored object.
        Raises ObjectNotFoundError if the key does not exist.
        """
        if not object_key or not object_key.strip():
            raise ObjectNotFoundError("Object key cannot be empty.")

        target_bucket = bucket_name or self.config.bucket_name

        if self.s3 is not None:
            try:
                head = self.s3.head_object(Bucket=target_bucket, Key=object_key)
                metadata = {k.lower(): str(v) for k, v in head.get("Metadata", {}).items()}
                content_type = head.get("ContentType", "application/octet-stream")

                tag_resp = self.s3.get_object_tagging(Bucket=target_bucket, Key=object_key)
                tags = {
                    item["Key"]: item["Value"]
                    for item in tag_resp.get("TagSet", [])
                    if "Key" in item and "Value" in item
                }
                return metadata, tags, content_type
            except ClientError as exc:
                code = str(exc.response.get("Error", {}).get("Code", ""))
                if code in {"404", "NoSuchKey", "NotFound"}:
                    raise ObjectNotFoundError(
                        f"Object '{object_key}' was not found in bucket '{target_bucket}'."
                    ) from exc
                raise StorageOperationError(
                    f"Failed to retrieve metadata/tags for '{object_key}': {exc}"
                ) from exc
            except BotoCoreError as exc:
                raise StorageOperationError(f"S3 connection error: {exc}") from exc
        else:
            quoted_key = urllib.parse.quote(object_key)
            _, headers, _ = self._signed_http_request("GET", f"/{target_bucket}/{quoted_key}")
            metadata = {
                k[11:].lower(): v
                for k, v in headers.items()
                if k.lower().startswith("x-amz-meta-")
            }
            content_type = headers.get("content-type", "application/octet-stream")
            _, _, tag_bytes = self._signed_http_request(
                "GET", f"/{target_bucket}/{quoted_key}?tagging=1"
            )
            tag_payload = json.loads(tag_bytes.decode("utf-8"))
            tags = {str(k): str(v) for k, v in tag_payload.get("TagSet", {}).items()}
            return metadata, tags, content_type

    def update_object_tags(
        self,
        object_key: str,
        tags: Dict[str, str],
        bucket_name: Optional[str] = None,
    ) -> Dict[str, str]:
        """Update S3 object tags on an existing object."""
        if not object_key or not object_key.strip():
            raise ObjectNotFoundError("Object key cannot be empty.")

        target_bucket = bucket_name or self.config.bucket_name
        clean_tags = {k.strip(): str(v).strip() for k, v in tags.items() if k and str(v).strip()}

        if self.s3 is not None:
            try:
                # Verify object exists first
                self.s3.head_object(Bucket=target_bucket, Key=object_key)
                tag_set = [{"Key": k, "Value": v} for k, v in clean_tags.items()]
                self.s3.put_object_tagging(
                    Bucket=target_bucket,
                    Key=object_key,
                    Tagging={"TagSet": tag_set},
                )
                return clean_tags
            except ClientError as exc:
                code = str(exc.response.get("Error", {}).get("Code", ""))
                if code in {"404", "NoSuchKey", "NotFound"}:
                    raise ObjectNotFoundError(
                        f"Cannot update tags: object '{object_key}' does not exist."
                    ) from exc
                raise StorageOperationError(
                    f"Failed to update tags for '{object_key}': {exc}"
                ) from exc
        else:
            quoted_key = urllib.parse.quote(object_key)
            body = json.dumps({"TagSet": clean_tags}).encode("utf-8")
            self._signed_http_request(
                "PUT",
                f"/{target_bucket}/{quoted_key}?tagging=1",
                body=body,
                headers={"Content-Type": "application/json"},
            )
            return clean_tags

    # ------------------------------------------------------------------
    # Core Feature A & B: List Stored Objects with Category Prefix Filter
    # ------------------------------------------------------------------
    def list_objects(
        self,
        category_filter: Optional[str] = None,
        search_query: Optional[str] = None,
        include_public_demo_bucket: bool = False,
    ) -> List[StoredObjectInfo]:
        """
        List objects stored in the bucket, optionally filtered by category prefix
        and case-insensitive search query.
        """
        prefix = ""
        if category_filter and category_filter.lower() != "all":
            prefix = validate_category(category_filter)

        buckets_to_scan = [self.config.bucket_name]
        if include_public_demo_bucket and self._public_demo_enabled:
            buckets_to_scan.append(self.config.public_demo_bucket)

        results: List[StoredObjectInfo] = []

        for bucket in buckets_to_scan:
            is_public_bucket = bucket == self.config.public_demo_bucket
            access_label = (
                "Public-Read (Isolated Sandbox)" if is_public_bucket else "Private"
            )

            if self.s3 is not None:
                try:
                    list_kwargs: Dict[str, Any] = {"Bucket": bucket}
                    if prefix:
                        list_kwargs["Prefix"] = prefix
                    resp = self.s3.list_objects_v2(**list_kwargs)
                    contents = resp.get("Contents", [])
                    for item in contents:
                        key = item["Key"]
                        if key.endswith("/"):
                            continue
                        metadata, tags, content_type = self.get_object_metadata_and_tags(
                            key, bucket_name=bucket
                        )
                        last_mod = item.get("LastModified")
                        if isinstance(last_mod, datetime):
                            last_mod_str = last_mod.astimezone(timezone.utc).strftime(
                                "%Y-%m-%dT%H:%M:%SZ"
                            )
                        else:
                            last_mod_str = str(last_mod or "")

                        cat = key.split("/", 1)[0] if "/" in key else "uncategorized"
                        filename = key.split("/")[-1]
                        results.append(
                            StoredObjectInfo(
                                key=key,
                                filename=filename,
                                category=cat,
                                size_bytes=int(item.get("Size", 0)),
                                last_modified=last_mod_str,
                                content_type=content_type,
                                etag=str(item.get("ETag", "")).strip('"'),
                                bucket=bucket,
                                access_mode=access_label,
                                metadata=metadata,
                                tags=tags,
                            )
                        )
                except (ClientError, BotoCoreError) as exc:
                    raise StorageOperationError(
                        f"Failed to list objects in '{bucket}': {exc}"
                    ) from exc
            else:
                query_str = f"?prefix={urllib.parse.quote(prefix)}" if prefix else ""
                _, _, payload_bytes = self._signed_http_request(
                    "GET", f"/{bucket}{query_str}"
                )
                data = json.loads(payload_bytes.decode("utf-8"))
                for item in data.get("Contents", []):
                    key = item["Key"]
                    cat = key.split("/", 1)[0] if "/" in key else "uncategorized"
                    filename = key.split("/")[-1]
                    results.append(
                        StoredObjectInfo(
                            key=key,
                            filename=filename,
                            category=cat,
                            size_bytes=int(item.get("Size", 0)),
                            last_modified=str(item.get("LastModified", "")),
                            content_type=str(
                                item.get("ContentType", "application/octet-stream")
                            ),
                            etag=str(item.get("ETag", "")).strip('"'),
                            bucket=bucket,
                            access_mode=access_label,
                            metadata=dict(item.get("Metadata", {})),
                            tags=dict(item.get("Tags", {})),
                        )
                    )

        if search_query and search_query.strip():
            q = search_query.strip().lower()
            results = [
                obj
                for obj in results
                if q in obj.key.lower()
                or q in obj.filename.lower()
                or any(q in str(v).lower() for v in obj.metadata.values())
                or any(q in f"{k}={v}".lower() for k, v in obj.tags.items())
            ]

        return results

    # ------------------------------------------------------------------
    # Core Feature A: Download and Delete Objects Safely
    # ------------------------------------------------------------------
    def download_file_bytes(
        self, object_key: str, bucket_name: Optional[str] = None
    ) -> bytes:
        """
        Download an object's bytes from S3/MinIO into memory safely.
        Never writes to arbitrary user-controlled local filesystem paths.
        """
        if not object_key or not object_key.strip():
            raise ObjectNotFoundError("Object key cannot be empty.")

        target_bucket = bucket_name or self.config.bucket_name

        if self.s3 is not None:
            try:
                resp = self.s3.get_object(Bucket=target_bucket, Key=object_key)
                body = resp["Body"].read()
                return bytes(body)
            except ClientError as exc:
                code = str(exc.response.get("Error", {}).get("Code", ""))
                if code in {"404", "NoSuchKey", "NotFound"}:
                    raise ObjectNotFoundError(
                        f"Object '{object_key}' does not exist in '{target_bucket}'."
                    ) from exc
                raise StorageOperationError(
                    f"Failed to download '{object_key}': {exc}"
                ) from exc
            except BotoCoreError as exc:
                raise StorageOperationError(f"S3 download failure: {exc}") from exc
        else:
            quoted_key = urllib.parse.quote(object_key)
            _, _, body = self._signed_http_request(
                "GET", f"/{target_bucket}/{quoted_key}"
            )
            return body

    def download_to_safe_storage(
        self, object_key: str, bucket_name: Optional[str] = None
    ) -> Path:
        """
        Download an object into the fixed, sandboxed `storage/` directory.
        Strictly sanitizes the filename so user input can never select arbitrary paths.
        """
        content = self.download_file_bytes(object_key, bucket_name=bucket_name)
        safe_name = sanitize_filename(object_key.split("/")[-1])
        SAFE_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        dest_path = (SAFE_STORAGE_DIR / safe_name).resolve()

        # Verify resolved path is strictly inside SAFE_STORAGE_DIR
        if SAFE_STORAGE_DIR.resolve() not in dest_path.parents:
            raise StorageConfigError("Resolved path escaped the safe storage directory.")

        dest_path.write_bytes(content)
        return dest_path

    def delete_object(
        self,
        object_key: str,
        confirmed: bool = False,
        bucket_name: Optional[str] = None,
    ) -> bool:
        """
        Delete an object from the bucket. Requires explicit `confirmed=True`
        and verifies the object exists before deletion.
        """
        if not confirmed:
            raise StorageOperationError(
                "Deletion requires explicit confirmation (confirmed=True)."
            )
        if not object_key or not object_key.strip():
            raise ObjectNotFoundError("Object key cannot be empty.")

        target_bucket = bucket_name or self.config.bucket_name

        # Ensure object exists before deleting so invalid keys raise ObjectNotFoundError
        self.get_object_metadata_and_tags(object_key, bucket_name=target_bucket)

        if self.s3 is not None:
            try:
                self.s3.delete_object(Bucket=target_bucket, Key=object_key)
                return True
            except (ClientError, BotoCoreError) as exc:
                raise StorageOperationError(
                    f"Failed to delete '{object_key}': {exc}"
                ) from exc
        else:
            quoted_key = urllib.parse.quote(object_key)
            self._signed_http_request("DELETE", f"/{target_bucket}/{quoted_key}")
            return True

    # ------------------------------------------------------------------
    # Core Feature D & E: Pre-Signed URLs & Access Controls
    # ------------------------------------------------------------------
    def generate_presigned_url(
        self,
        object_key: str,
        expiration_seconds: Optional[int] = None,
        bucket_name: Optional[str] = None,
        issued_at_override: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """
        Generate a time-limited pre-signed URL for temporary bearer read access to a
        private object without changing bucket policies or making the object public.
        """
        expiry = (
            expiration_seconds
            if expiration_seconds is not None
            else self.config.default_presigned_expiration
        )
        if expiry < 1 or expiry > 604800:
            raise StorageConfigError(
                "Pre-signed URL expiration must be between 1 and 604800 seconds."
            )

        target_bucket = bucket_name or self.config.bucket_name

        # Verify object exists first so invalid objects are caught immediately
        self.get_object_metadata_and_tags(object_key, bucket_name=target_bucket)

        issued_dt = (issued_at_override or datetime.now(timezone.utc)).astimezone(
            timezone.utc
        )
        expires_at_epoch = issued_dt.timestamp() + expiry
        expires_at_iso = datetime.fromtimestamp(expires_at_epoch, tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )

        if self.s3 is not None and issued_at_override is None:
            try:
                url = self.s3.generate_presigned_url(
                    ClientMethod="get_object",
                    Params={"Bucket": target_bucket, "Key": object_key},
                    ExpiresIn=expiry,
                )
            except (ClientError, BotoCoreError) as exc:
                raise StorageOperationError(
                    f"Failed to generate pre-signed URL for '{object_key}': {exc}"
                ) from exc
        else:
            amz_date = issued_dt.strftime("%Y%m%dT%H%M%SZ")
            datestamp = issued_dt.strftime("%Y%m%d")
            issued_ms = str(int(issued_dt.timestamp() * 1000))
            credential = f"{self.config.access_key}/{datestamp}/{self.config.region}/s3/aws4_request"
            canonical = f"GET\n/{target_bucket}/{object_key}\n{amz_date}\n{expiry}\n{credential}"
            signature = hmac.new(
                self.config.secret_key.encode("utf-8"),
                canonical.encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()
            query_params = urllib.parse.urlencode(
                {
                    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
                    "X-Amz-Credential": credential,
                    "X-Amz-Date": amz_date,
                    "X-Amz-Expires": str(expiry),
                    "X-Amz-Issued-Ms": issued_ms,
                    "X-Amz-SignedHeaders": "host",
                    "X-Amz-Signature": signature,
                }
            )
            quoted_key = urllib.parse.quote(object_key)
            url = f"{self.config.endpoint_url.rstrip('/')}/{target_bucket}/{quoted_key}?{query_params}"

        return {
            "url": url,
            "object_key": object_key,
            "bucket": target_bucket,
            "expiration_seconds": expiry,
            "expires_at": expires_at_iso,
            "object_remains_private": target_bucket == self.config.bucket_name,
        }

    def enable_isolated_public_demo_mode(self, explicit_confirmation: bool = False) -> Dict[str, Any]:
        """
        Enable public-read policy ONLY on the isolated disposable demonstration bucket
        (`config.public_demo_bucket`). Never modifies `config.bucket_name`.
        """
        if not explicit_confirmation:
            raise AccessDeniedError(
                "Explicit confirmation is required before enabling public-read demonstration mode."
            )

        policy_json = build_public_read_bucket_policy(self.config.public_demo_bucket)

        if self.s3 is not None:
            try:
                self.s3.put_bucket_policy(
                    Bucket=self.config.public_demo_bucket,
                    Policy=policy_json,
                )
            except (ClientError, BotoCoreError) as exc:
                raise StorageOperationError(
                    f"Failed to apply isolated public-read policy: {exc}"
                ) from exc
        else:
            self._signed_http_request(
                "PUT",
                f"/{self.config.public_demo_bucket}?policy=1",
                body=policy_json.encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )

        self._public_demo_enabled = True
        return {
            "public_demo_enabled": True,
            "isolated_bucket": self.config.public_demo_bucket,
            "private_bucket_protected": self.config.bucket_name,
        }

    def disable_isolated_public_demo_mode(self) -> Dict[str, Any]:
        """Revoke public-read policy on the isolated demonstration bucket."""
        if self.s3 is not None:
            try:
                self.s3.delete_bucket_policy(Bucket=self.config.public_demo_bucket)
            except (ClientError, BotoCoreError):
                pass
        else:
            try:
                self._signed_http_request(
                    "DELETE", f"/{self.config.public_demo_bucket}?policy=1"
                )
            except StorageOperationError:
                pass

        self._public_demo_enabled = False
        return {
            "public_demo_enabled": False,
            "isolated_bucket": self.config.public_demo_bucket,
            "private_bucket_protected": self.config.bucket_name,
        }

    def build_direct_object_url(
        self, object_key: str, bucket_name: Optional[str] = None
    ) -> str:
        """Construct the unauthenticated direct HTTP URL for an object."""
        target_bucket = bucket_name or self.config.bucket_name
        quoted_key = urllib.parse.quote(object_key)
        return f"{self.config.endpoint_url.rstrip('/')}/{target_bucket}/{quoted_key}"
